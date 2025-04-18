/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'assert'
import * as path from 'path'
import * as vscode from 'vscode'
import {
    collectFiles,
    collectFilesForIndex,
    CollectFilesResultItem,
    findParentProjectFile,
    findStringInDirectory,
    getWorkspaceFoldersByPrefixes,
    getWorkspaceRelativePath,
} from '../../../shared/utilities/workspaceUtils'
import { getTestWorkspaceFolder } from '../../integrationTestsUtilities'
import globals from '../../../shared/extensionGlobals'
import { CodelensRootRegistry } from '../../../shared/fs/codelensRootRegistry'
import { createTestWorkspace, createTestWorkspaceFolder, toFile } from '../../../test/testUtil'
import sinon from 'sinon'
import { fs, ToolkitError } from '../../../shared'

describe('workspaceUtils', () => {
    let sandbox: sinon.SinonSandbox

    beforeEach(() => {
        sandbox = sinon.createSandbox()
    })

    afterEach(() => {
        sandbox.restore()
    })

    describe('findParentProjectFile', async function () {
        const workspaceDir = getTestWorkspaceFolder()
        let filesToDelete: vscode.Uri[]

        // Save the global registry and restore it after the test
        let globalRegistry: CodelensRootRegistry

        const sourceCodeUri = vscode.Uri.file(path.join(workspaceDir, 'someproject', 'src', 'Program.cs'))
        const projectInSameFolderUri = vscode.Uri.file(path.join(workspaceDir, 'someproject', 'src', 'App.csproj'))
        const projectInParentFolderUri = vscode.Uri.file(path.join(workspaceDir, 'someproject', 'App.csproj'))
        const projectInParentParentFolderUri = vscode.Uri.file(path.join(workspaceDir, 'App.csproj'))
        const projectOutOfParentChainUri = vscode.Uri.file(path.join(workspaceDir, 'someotherproject', 'App.csproj'))

        const testScenarios = [
            {
                scenario: 'locates project in same folder',
                filesToUse: [projectInSameFolderUri],
                expectedResult: projectInSameFolderUri,
            },
            {
                scenario: 'locates project in parent folder',
                filesToUse: [projectInParentFolderUri],
                expectedResult: projectInParentFolderUri,
            },
            {
                scenario: 'locates project two parent folders up',
                filesToUse: [projectInParentParentFolderUri],
                expectedResult: projectInParentParentFolderUri,
            },
            {
                scenario: 'selects project in same folder over parent folder',
                filesToUse: [projectInSameFolderUri, projectInParentFolderUri],
                expectedResult: projectInSameFolderUri,
            },
            {
                scenario: 'always selects project in same folder over parent folder regardless of order',
                filesToUse: [projectInParentFolderUri, projectInSameFolderUri],
                expectedResult: projectInSameFolderUri,
            },
            {
                scenario: 'returns undefined when no project files are located',
                filesToUse: [],
                expectedResult: undefined,
            },
            {
                scenario: 'returns undefined when no project files are located in parent chain',
                filesToUse: [projectOutOfParentChainUri],
                expectedResult: undefined,
            },
        ]

        before(async function () {
            await fs.mkdir(path.join(workspaceDir, 'someproject', 'src'))
            await fs.mkdir(path.join(workspaceDir, 'someotherproject'))
            globalRegistry = globals.codelensRootRegistry
        })

        after(async function () {
            await fs.delete(path.join(workspaceDir, 'someproject'), { recursive: true })
            await fs.delete(path.join(workspaceDir, 'someotherproject'), { recursive: true })
            globals.codelensRootRegistry = globalRegistry
        })

        beforeEach(function () {
            globals.codelensRootRegistry = new CodelensRootRegistry()
        })

        afterEach(async function () {
            for (const file of filesToDelete) {
                await fs.delete(file.fsPath)
            }
            filesToDelete = []
            globals.codelensRootRegistry.dispose()
        })

        for (const test of testScenarios) {
            it(test.scenario, async () => {
                filesToDelete = test.filesToUse
                for (const file of test.filesToUse) {
                    await fs.writeFile(file.fsPath, '')
                    // Add it to the registry. The registry is async and we are not
                    // testing the registry in this test, so manually use it
                    await globals.codelensRootRegistry.addItem(file)
                }
                const projectFile = await findParentProjectFile(sourceCodeUri, /^.*\.csproj$/)
                if (test.expectedResult) {
                    // doesn't do a deepStrictEqual because VS Code sets a hidden field to `undefined` when returning instead of `null` (when it's created)
                    // for all intents and purposes, if this matches, it's good enough for us.
                    assert.strictEqual(projectFile?.fsPath, test.expectedResult?.fsPath)
                } else {
                    assert.strictEqual(projectFile, test.expectedResult)
                }
            })
        }
    })

    describe('getWorkspaceRelativePath', function () {
        const parentPath = path.join('/', 'level1', 'level2')
        const nestedPath = path.join(parentPath, 'level3')
        const childPath = path.join(nestedPath, 'level4')

        it('returns a path relative to the first parent path it sees', function () {
            const workspaceFolder = {
                index: 0,
                name: '',
                uri: vscode.Uri.file(nestedPath),
            }

            const relativePath = getWorkspaceRelativePath(childPath, {
                workspaceFolders: [
                    workspaceFolder,
                    {
                        index: 1,
                        name: '',
                        uri: vscode.Uri.file(parentPath),
                    },
                ],
            })

            assert.strictEqual(relativePath?.relativePath, 'level4')
            assert.strictEqual(relativePath?.workspaceFolder, workspaceFolder)
        })

        it('returns undefined if no workspace folders exist', function () {
            const relativePath = getWorkspaceRelativePath(childPath, { workspaceFolders: undefined })
            assert.strictEqual(relativePath, undefined)
        })

        it('returns undefined if no paths are parents', function () {
            const relativePath = getWorkspaceRelativePath(childPath, {
                workspaceFolders: [
                    {
                        index: 0,
                        name: '',
                        uri: vscode.Uri.file(path.join('different', nestedPath)),
                    },
                    {
                        index: 1,
                        name: '',
                        uri: vscode.Uri.file(path.join('different', parentPath)),
                    },
                ],
            })
            assert.strictEqual(relativePath, undefined)
        })
    })

    describe('collectFiles', function () {
        it('returns all files in the workspace', async function () {
            // these variables are a manual selection of settings for the test in order to test the collectFiles function
            const workspaceFolders = [
                { fileAmount: 2, fileNamePrefix: 'file', fileContent: 'test content', workspaceName: 'app' },
                { fileAmount: 2, fileNamePrefix: 'file', fileContent: 'test content', workspaceName: 'test' },
            ] satisfies (Parameters<typeof createTestWorkspace>[1] & { fileAmount: number })[]

            const workspaces: [vscode.WorkspaceFolder, vscode.WorkspaceFolder] = [
                await createTestWorkspace(workspaceFolders[0].fileAmount, workspaceFolders[0]),
                await createTestWorkspace(workspaceFolders[1].fileAmount, workspaceFolders[1]),
            ]
            sandbox.stub(vscode.workspace, 'workspaceFolders').value(workspaces)

            const result = await collectFiles(
                workspaces.map((ws) => ws.uri.fsPath),
                workspaces,
                { excludeByGitIgnore: false }
            )
            assert.strictEqual(
                result.length,
                workspaceFolders.reduce((sum, ws) => sum + ws.fileAmount, 0)
            )
            let currentIndex = 0
            for (const workspaceFolder of workspaceFolders) {
                for (let i = currentIndex; i < currentIndex + workspaceFolder.fileAmount; i++) {
                    assert.strictEqual(result[i].relativeFilePath.includes(workspaceFolder.fileNamePrefix), true)
                    assert.strictEqual(result[i].zipFilePath.startsWith(workspaceFolder.workspaceName), true)
                    assert.strictEqual(result[i].fileContent, workspaceFolder.fileContent)
                }
                currentIndex += workspaceFolder.fileAmount
            }
        })

        it('returns all files in the workspace not excluded by gitignore', async function () {
            // these variables are a manual selection of settings for the test in order to test the collectFiles function
            const fileAmount = 3
            const fileNamePrefix = 'file'
            const fileContent = 'test content'

            const workspaceFolder = await createTestWorkspace(fileAmount, { fileNamePrefix, fileContent })

            const writeFile = (pathParts: string[], fileContent: string) => {
                return toFile(fileContent, path.join(workspaceFolder.uri.fsPath, ...pathParts))
            }

            sandbox.stub(vscode.workspace, 'workspaceFolders').value([workspaceFolder])
            const gitignoreContent = `file2
            # different formats of prefixes
            /build
            node_modules

            #some comment

            range_file[0-5]
            `
            await writeFile(['.gitignore'], gitignoreContent)

            await writeFile(['build', `ignored1`], fileContent)
            await writeFile(['build', `ignored2`], fileContent)

            await writeFile(['node_modules', `ignored1`], fileContent)
            await writeFile(['node_modules', `ignored2`], fileContent)

            await writeFile([`range_file0`], fileContent)
            await writeFile([`range_file9`], fileContent)

            const gitignore2 = 'folder1\n'
            await writeFile(['src', '.gitignore'], gitignore2)
            await writeFile(['src', 'folder2', 'a.js'], fileContent)

            const gitignore3 = `negate_test*
            !negate_test[0-5]`
            await writeFile(['src', 'folder3', '.gitignore'], gitignore3)
            await writeFile(['src', 'folder3', 'negate_test1'], fileContent)
            await writeFile(['src', 'folder3', 'negate_test6'], fileContent)

            const result = processIndexResults(await collectFiles([workspaceFolder.uri.fsPath], [workspaceFolder]))

            // non-posix filePath check here is important.
            assert.deepStrictEqual(
                [
                    {
                        workspaceFolder,
                        relativeFilePath: '.gitignore',
                        fileContent: gitignoreContent,
                        fileSizeBytes: 162,
                    },
                    {
                        workspaceFolder,
                        relativeFilePath: 'file1',
                        fileContent: 'test content',
                        fileSizeBytes: 12,
                    },
                    {
                        workspaceFolder,
                        relativeFilePath: 'file3',
                        fileContent: 'test content',
                        fileSizeBytes: 12,
                    },
                    {
                        workspaceFolder,
                        relativeFilePath: 'range_file9',
                        fileContent: 'test content',
                        fileSizeBytes: 12,
                    },
                    {
                        workspaceFolder,
                        relativeFilePath: path.join('src', '.gitignore'),
                        fileContent: gitignore2,
                        fileSizeBytes: 8,
                    },
                    {
                        workspaceFolder,
                        relativeFilePath: path.join('src', 'folder2', 'a.js'),
                        fileContent: fileContent,
                        fileSizeBytes: 12,
                    },
                    {
                        workspaceFolder,
                        relativeFilePath: path.join('src', 'folder3', '.gitignore'),
                        fileContent: gitignore3,
                        fileSizeBytes: 42,
                    },
                    {
                        workspaceFolder,
                        relativeFilePath: path.join('src', 'folder3', 'negate_test1'),
                        fileContent: fileContent,
                        fileSizeBytes: 12,
                    },
                ] satisfies typeof result,
                result
            )
        })

        it('does not return license files', async function () {
            const workspace = await createTestWorkspaceFolder()

            sandbox.stub(vscode.workspace, 'workspaceFolders').value([workspace])

            const fileContent = ''
            for (const fmt of ['txt', 'md']) {
                // root license files
                await toFile(fileContent, path.join(workspace.uri.fsPath, `license.${fmt}`))
                await toFile(fileContent, path.join(workspace.uri.fsPath, `License.${fmt}`))
                await toFile(fileContent, path.join(workspace.uri.fsPath, `LICENSE.${fmt}`))

                // nested license files
                await toFile(fileContent, path.join(workspace.uri.fsPath, `src/license.${fmt}`))
                await toFile(fileContent, path.join(workspace.uri.fsPath, `src/License.${fmt}`))
                await toFile(fileContent, path.join(workspace.uri.fsPath, `src/LICENSE.${fmt}`))
            }

            // add a non license file too, to make sure it is returned
            await toFile(fileContent, path.join(workspace.uri.fsPath, 'non-license.md'))

            const result = await collectFiles([workspace.uri.fsPath], [workspace])

            assert.deepStrictEqual(1, result.length)
            assert.deepStrictEqual('non-license.md', result[0].relativeFilePath)
        })

        it('throws when total size limit is exceeded (by default)', async function () {
            const workspace = await createTestWorkspaceFolder()
            sandbox.stub(vscode.workspace, 'workspaceFolders').value([workspace])

            const fileContent = 'this is some text'
            await toFile(fileContent, path.join(workspace.uri.fsPath, 'file1'))
            await toFile(fileContent, path.join(workspace.uri.fsPath, 'file2'))

            await assert.rejects(
                () => collectFiles([workspace.uri.fsPath], [workspace], { maxTotalSizeBytes: 15 }),
                (e) => e instanceof ToolkitError && e.code === 'ContentLengthError'
            )
        })
    })

    describe('getWorkspaceFoldersByPrefixes', function () {
        it('returns undefined for single workspace folder', async () => {
            const result = getWorkspaceFoldersByPrefixes([await createTestWorkspace(1, {})])
            assert.strictEqual(result, undefined)
        })
        it('prefixes folders based on their name if possible', async () => {
            const ws1 = await createTestWorkspace(1, { fileNamePrefix: 'ws1', workspaceName: 'test' })
            const ws2 = await createTestWorkspace(1, { fileNamePrefix: 'ws2', workspaceName: 'app' })
            const result = getWorkspaceFoldersByPrefixes([ws1, ws2])
            assert.deepStrictEqual(result, { test: ws1, app: ws2 })
        })

        it('prefixes folders based on their folder parts, if the names collide', async () => {
            const ws1 = await createTestWorkspace(1, {
                fileNamePrefix: 'ws1',
                workspaceName: 'cdk',
                subDir: 'test/app/cdk',
            })
            const ws2 = await createTestWorkspace(1, {
                fileNamePrefix: 'ws2',
                workspaceName: 'cdk',
                subDir: 'canary/app/cdk',
            })
            const result = getWorkspaceFoldersByPrefixes([ws1, ws2])
            assert.deepStrictEqual(result, { test_app_cdk_cdk: ws1, canary_app_cdk_cdk: ws2 })
        })

        it('when a folder collides with another one in prefixing, it will get the shorter prefix if there are no contenders', async () => {
            const ws1 = await createTestWorkspace(1, {
                fileNamePrefix: 'ws1',
                workspaceName: 'cdk',
                subDir: 'test/app/cdk',
            })
            const ws2 = await createTestWorkspace(1, {
                fileNamePrefix: 'ws2',
                workspaceName: 'cdk',
                subDir: ws1.uri.fsPath.replace(':', '_'),
            })
            const result = getWorkspaceFoldersByPrefixes([ws1, ws2])
            const keys = Object.keys(result ?? {})
            assert.strictEqual(keys.length, 2)
            const keyForWs1 = result?.[keys[0]] === ws1 ? keys[0] : keys[1]
            const keyForWs2 = keyForWs1 === keys[0] ? keys[1] : keys[0]
            assert.strictEqual(
                keyForWs2.includes(keyForWs1),
                true,
                `Expected [${keyForWs1}] to be a prefix of [${keyForWs2}]`
            )
            assert.strictEqual(
                keyForWs2.length > keyForWs1.length,
                true,
                `Expected [${keyForWs1}] to be a prefix of [${keyForWs2}]`
            )
        })

        it('when 2 folders collide, they will get suffixed', async () => {
            // the first 2 collide all the way
            const ws1 = await createTestWorkspace(1, {
                fileNamePrefix: 'ws1',
                workspaceName: 'cdk_ws',
                subDir: 'test/app',
            })
            const newRoot = path.join(ws1.uri.fsPath, '../app_cdk')
            await fs.mkdir(newRoot)
            const ws2: vscode.WorkspaceFolder = {
                index: 0,
                uri: vscode.Uri.file(newRoot),
                name: 'ws',
            }
            const ws3 = await createTestWorkspace(1, {
                fileNamePrefix: 'ws2',
                workspaceName: 'cdk_ws',
                subDir: 'test/zz1',
            })
            const ws4 = await createTestWorkspace(1, {
                fileNamePrefix: 'ws2',
                workspaceName: 'ws',
                subDir: 'test/zz2',
            })
            const result = getWorkspaceFoldersByPrefixes([ws1, ws2, ws3, ws4])
            const keys = Object.keys(result ?? {})
            assert.strictEqual(keys.length, 4, `Incorrect number of entries in result [${JSON.stringify(result)}]`)
            const orderedKeys = keys.sort()
            assert.strictEqual(
                orderedKeys[0].substring(0, orderedKeys[0].length - 2),
                orderedKeys[1].substring(0, orderedKeys[1].length - 2),
                `Incorrect prefixes for colliding workspaces [${orderedKeys[0]}, ${orderedKeys[1]}]`
            )
            assert.strictEqual(
                orderedKeys[0].substring(orderedKeys[0].length - 2),
                '_1',
                `Incorrect prefix for first workspace [${orderedKeys[0]}]`
            )
            assert.strictEqual(
                orderedKeys[1].substring(orderedKeys[1].length - 2),
                '_2',
                `Incorrect prefix for second workspace [${orderedKeys[1]}]`
            )
        })
    })

    describe('collectFilesForIndex', function () {
        let workspaceFolder: vscode.WorkspaceFolder

        const writeFile = (pathParts: string[], fileContent: string) => {
            return toFile(fileContent, path.join(workspaceFolder.uri.fsPath, ...pathParts))
        }

        beforeEach(async function () {
            workspaceFolder = await createTestWorkspaceFolder()
            sandbox.stub(vscode.workspace, 'workspaceFolders').value([workspaceFolder])
        })

        it('returns all files in the workspace not excluded by gitignore and is a supported programming language', async function () {
            const fileContent = 'test content'

            const gitignoreContent = `file2
            # different formats of prefixes
            /build
            node_modules

            #some comment

            range_file[0-5]
            `
            await writeFile(['.gitignore'], gitignoreContent)

            await writeFile(['build', `ignored1`], fileContent)
            await writeFile(['build', `ignored2`], fileContent)

            await writeFile(['node_modules', `ignored1`], fileContent)
            await writeFile(['node_modules', `ignored2`], fileContent)

            await writeFile([`range_file0`], fileContent)
            await writeFile([`range_file9`], fileContent)

            const gitignore2 = 'folder1\n'
            await writeFile(['src', '.gitignore'], gitignore2)
            await writeFile(['src', 'folder2', 'a.js'], fileContent)
            await writeFile(['src', 'folder2', 'b.cs'], fileContent)
            await writeFile(['src', 'folder2', 'c.bin'], fileContent)
            await writeFile(['src', 'folder2', 'd.pyc'], fileContent)

            const gitignore3 = `negate_test*
            !negate_test[0-5]`
            await writeFile(['src', 'folder3', '.gitignore'], gitignore3)
            await writeFile(['src', 'folder3', 'negate_test1'], fileContent)
            await writeFile(['src', 'folder3', 'negate_test6'], fileContent)

            const result = processIndexResults(
                await collectFilesForIndex([workspaceFolder.uri.fsPath], [workspaceFolder], true)
            )

            // non-posix filePath check here is important.
            assert.deepStrictEqual(
                [
                    {
                        workspaceFolder,
                        relativeFilePath: path.join('src', 'folder2', 'a.js'),
                        fileSizeBytes: 12,
                    },
                    {
                        workspaceFolder,
                        relativeFilePath: path.join('src', 'folder2', 'b.cs'),
                        fileSizeBytes: 12,
                    },
                ] satisfies typeof result,
                result
            )
        })

        it('does not include build related files', async function () {
            const fileContent = 'this is a file'

            await writeFile(['bin', `ignored1`], fileContent)
            await writeFile(['bin', `ignored2`], fileContent)

            await writeFile([`a.js`], fileContent)
            await writeFile([`b.java`], fileContent)

            const result = processIndexResults(
                await collectFilesForIndex([workspaceFolder.uri.fsPath], [workspaceFolder], true)
            )

            // non-posix filePath check here is important.
            assert.deepStrictEqual(
                [
                    {
                        workspaceFolder,
                        relativeFilePath: 'a.js',
                        fileSizeBytes: 14,
                    },
                    {
                        workspaceFolder,
                        relativeFilePath: 'b.java',
                        fileSizeBytes: 14,
                    },
                ] satisfies typeof result,
                result
            )
        })

        it('returns top level files when max size is reached', async function () {
            const fileContent = 'this is a file'

            await writeFile(['path', 'to', 'file', 'bot.js'], fileContent)
            await writeFile(['path', 'to', 'file', `bot.java`], fileContent)

            await writeFile([`top.js`], fileContent)
            await writeFile([`top.java`], fileContent)

            const result = processIndexResults(
                await collectFilesForIndex([workspaceFolder.uri.fsPath], [workspaceFolder], true, 30)
            )

            // non-posix filePath check here is important.
            assert.deepStrictEqual(
                [
                    {
                        workspaceFolder,
                        relativeFilePath: 'top.java',
                        fileSizeBytes: 14,
                    },
                    {
                        workspaceFolder,
                        relativeFilePath: 'top.js',
                        fileSizeBytes: 14,
                    },
                ] satisfies typeof result,
                result
            )
        })
    })

    describe('findStringInDirectory', function () {
        it('prints the line with the detected string to stdout', async () => {
            const fileAmount = 1
            const searchStr = 'oracle.jdbc.OracleDriver'
            const fileContent = `test content ${searchStr} more test content`
            const workspaceFolder = await createTestWorkspace(fileAmount, { fileContent: fileContent })
            const spawnResult = await findStringInDirectory(searchStr, workspaceFolder.uri.fsPath)
            assert.equal(spawnResult.stdout.includes(searchStr), true)
        })
    })
})

// for some reason, uri created inline differ in subfields, so skipping them from assertion
function processIndexResults(results: Omit<CollectFilesResultItem, 'fileContent'>[] | CollectFilesResultItem[]) {
    return results
        .map(({ zipFilePath, fileUri, ...r }) => ({ ...r }))
        .sort((l, r) => l.relativeFilePath.localeCompare(r.relativeFilePath))
}
