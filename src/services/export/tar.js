"use strict";

const html = require('html');
const repository = require('../repository');
const tar = require('tar-stream');
const path = require('path');
const mimeTypes = require('mime-types');
const TurndownService = require('turndown');
const packageInfo = require('../../../package.json');
const utils = require('../utils');
const log = require('../log');
const sanitize = require("sanitize-filename");

/**
 * @param {ExportContext} exportContext
 * @param {Branch} branch
 * @param {string} format - 'html' or 'markdown'
 */
async function exportToTar(exportContext, branch, format, res) {
    let turndownService = format === 'markdown' ? new TurndownService() : null;

    const pack = tar.pack();

    const noteIdToMeta = {};

    function getUniqueFilename(existingFileNames, fileName) {
        const lcFileName = fileName.toLowerCase();

        if (lcFileName in existingFileNames) {
            let index;
            let newName;

            do {
                index = existingFileNames[lcFileName]++;

                newName = index + "_" + lcFileName;
            }
            while (newName in existingFileNames);

            return index + "_" + fileName;
        }
        else {
            existingFileNames[lcFileName] = 1;

            return fileName;
        }
    }

    function getDataFileName(note, baseFileName, existingFileNames) {
        const existingExtension = path.extname(baseFileName).toLowerCase();
        let newExtension;

        // following two are handled specifically since we always want to have these extensions no matter the automatic detection
        // and/or existing detected extensions in the note name
        if (note.type === 'text' && format === 'markdown') {
            newExtension = 'md';
        }
        else if (note.type === 'text' && format === 'html') {
            newExtension = 'html';
        }
        else if (note.mime === 'application/x-javascript' || note.mime === 'text/javascript') {
            newExtension = 'js';
        }
        else if (existingExtension.length > 0) { // if the page already has an extension, then we'll just keep it
            newExtension = null;
        }
        else {
            newExtension = mimeTypes.extension(note.mime) || "dat";
        }

        let fileName = baseFileName;

        // if the note is already named with extension (e.g. "jquery.js"), then it's silly to append exact same extension again
        if (newExtension && existingExtension !== "." + newExtension.toLowerCase()) {
            fileName += "." + newExtension;
        }

        return getUniqueFilename(existingFileNames, fileName);
    }

    async function getNoteMeta(branch, parentMeta, existingFileNames) {
        const note = await branch.getNote();

        if (await note.hasLabel('excludeFromExport')) {
            return;
        }

        const baseFileName = sanitize(branch.prefix ? (branch.prefix + ' - ' + note.title) : note.title);

        if (note.noteId in noteIdToMeta) {
            const fileName = getUniqueFilename(existingFileNames, baseFileName + ".clone");

            return {
                isClone: true,
                noteId: note.noteId,
                prefix: branch.prefix,
                dataFileName: fileName
            };
        }

        const meta = {
            isClone: false,
            noteId: note.noteId,
            notePath: parentMeta.notePath.concat([note.noteId]),
            title: note.title,
            notePosition: branch.notePosition,
            prefix: branch.prefix,
            isExpanded: branch.isExpanded,
            type: note.type,
            mime: note.mime,
            // we don't export utcDateCreated and utcDateModified of any entity since that would be a bit misleading
            attributes: (await note.getOwnedAttributes()).map(attribute => {
                return {
                    type: attribute.type,
                    name: attribute.name,
                    value: attribute.value,
                    isInheritable: attribute.isInheritable,
                    position: attribute.position
                };
            })
        };

        exportContext.increaseProgressCount();

        if (note.type === 'text') {
            meta.format = format;
        }

        noteIdToMeta[note.noteId] = meta;

        const childBranches = await note.getChildBranches();

        // if it's a leaf then we'll export it even if it's empty
        if ((await note.getContent()).length > 0 || childBranches.length === 0) {
            meta.dataFileName = getDataFileName(note, baseFileName, existingFileNames);
        }

        if (childBranches.length > 0) {
            meta.dirFileName = getUniqueFilename(existingFileNames, baseFileName);
            meta.children = [];

            // namespace is shared by children in the same note
            const childExistingNames = {};

            for (const childBranch of childBranches) {
                const note = await getNoteMeta(childBranch, meta, childExistingNames);

                // can be undefined if export is disabled for this note
                if (note) {
                    meta.children.push(note);
                }
            }
        }

        return meta;
    }

    function findImageLinks(content, noteMeta) {
        try {
            return content.replace(/src="[^"]*api\/images\/([a-zA-Z0-9]+)\/[^"]*"/g, (_, targetNoteId) => {
                const targetNoteMeta = noteIdToMeta[targetNoteId];

                if (!targetNoteMeta) {
                    return null;
                }

                const targetPath = targetNoteMeta.notePath.slice();
                const sourcePath = noteMeta.notePath.slice();

                console.log("targetPath", targetPath);
                console.log("sourcePath", sourcePath);

                // > 1 for edge case that targetPath and sourcePath are exact same (link to itself)
                while (targetPath.length > 1 && sourcePath.length > 1 && targetPath[0] === sourcePath[0]) {
                    targetPath.shift();
                    sourcePath.shift();
                }

                console.log("targetPath", targetPath);
                console.log("sourcePath", sourcePath);

                let url = "../".repeat(sourcePath.length - 1);

                for (let i = 0; i < targetPath.length - 1; i++) {
                    const meta = noteIdToMeta[targetPath[i]];

                    url += meta.dirFileName + '/';
                }

                const meta = noteIdToMeta[targetPath[targetPath.length - 1]];

                url += meta.dataFileName;

                console.log("URL", url);

                return url;
            });
        }
        catch (e) {
            log.error("Could not parse links from", content);
            throw e;
        }
    }

    async function prepareContent(note, noteMeta) {
        let content = await note.getContent();

        if (['html', 'markdown'].includes(noteMeta.format)) {
            content = content.toString();

            findImageLinks(content, noteMeta);
        }

        if (noteMeta.format === 'html') {
            if (!content.toLowerCase().includes("<html")) {
                note.content = '<html><head><meta charset="utf-8"></head><body>' + content + '</body></html>';
            }

            return html.prettyPrint(content, {indent_size: 2});
        }
        else if (noteMeta.format === 'markdown') {
            return turndownService.turndown(content);
        }
        else {
            return content;
        }
    }

    // noteId => file path
    const notePaths = {};

    async function saveNote(noteMeta, filePathPrefix) {
        if (noteMeta.isClone) {
            const content = "Note is present at " + notePaths[noteMeta.noteId];

            pack.entry({name: filePathPrefix + noteMeta.dataFileName, size: content.length}, content);
            return;
        }

        const note = await repository.getNote(noteMeta.noteId);

        notePaths[note.noteId] = filePathPrefix + (noteMeta.dataFileName || noteMeta.dirFileName);

        if (noteMeta.dataFileName) {
            const content = await prepareContent(note, noteMeta);

            pack.entry({name: filePathPrefix + noteMeta.dataFileName, size: content.length}, content);
        }

        exportContext.increaseProgressCount();

        if (noteMeta.children && noteMeta.children.length > 0) {
            const directoryPath = filePathPrefix + noteMeta.dirFileName;

            pack.entry({name: directoryPath, type: 'directory'});

            for (const childMeta of noteMeta.children) {
                await saveNote(childMeta, directoryPath + '/');
            }
        }
    }

    const metaFile = {
        formatVersion: 1,
        appVersion: packageInfo.version,
        files: [
            await getNoteMeta(branch, { notePath: [] }, [])
        ]
    };

    for (const noteMeta of Object.values(noteIdToMeta)) {
        // filter out relations which are not inside this export
        noteMeta.attributes = noteMeta.attributes.filter(attr => attr.type !== 'relation' || attr.value in noteIdToMeta);
    }

    if (!metaFile.files[0]) { // corner case of disabled export for exported note
        res.sendStatus(400);
        return;
    }

    const metaFileJson = JSON.stringify(metaFile, null, '\t');

    pack.entry({name: "!!!meta.json", size: metaFileJson.length}, metaFileJson);

    await saveNote(metaFile.files[0], '');

    pack.finalize();

    const note = await branch.getNote();
    const tarFileName = (branch.prefix ? (branch.prefix + " - ") : "") + note.title + ".tar";

    res.setHeader('Content-Disposition', utils.getContentDisposition(tarFileName));
    res.setHeader('Content-Type', 'application/tar');

    pack.pipe(res);

    exportContext.exportFinished();
}

module.exports = {
    exportToTar
};