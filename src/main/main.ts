import { app, BrowserWindow, ipcMain, protocol, dialog, shell, net } from 'electron'
import started from 'electron-squirrel-startup'

// Handle creating/removing shortcuts on Windows when installing/uninstalling.²
if (started) {
  app.quit()
}

import fs from 'fs'
import { join, basename, dirname } from 'path'
import { pathToFileURL } from 'url'
import { updateElectronApp } from 'update-electron-app'
import fontList from 'font-list'

import createMainWindow from './MainWindow'
import GameHandler from './GameHandler'
import { database } from './utils/Database'
import { loadCustomFlags, findFlagFile } from './lib/flags/flags'
import { version } from '../../package.json'

if (process.platform == 'win32') updateElectronApp()

const appDataPath = app.getPath('userData')
const dbPath = join(appDataPath, 'scores.db')
const db = database(dbPath)

protocol.registerSchemesAsPrivileged([
  { scheme: 'asset', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'flag', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

app.whenReady().then(async () => {
  serveAssets()
  await serveFlags()

  const mainWindow = createMainWindow()
  const gameHandler = new GameHandler(db, mainWindow)

  ipcMain.handle('get-youtube-connection-state', () => gameHandler.getYouTubeConnectionState())

  ipcMain.handle('read-audio-file-as-buffer', async (_event, pathArg: string) => {
    const audioPath = getAppDataPathIfExists(pathArg)
    if (!audioPath) return

    try {
      const data = await fs.promises.readFile(decodeURIComponent(audioPath))
      return Buffer.from(data) // Return the audio data as a buffer
    } catch (err) {
      console.error('Failed to load audio:', err)
      throw new Error('FILE_NOT_FOUND', { cause: err })
    }
  })

  ipcMain.handle('save-audio-file', async (_event, pathArg: string) => {
    return new Promise<void>((resolve, reject) => {
      dialog
        .showOpenDialog(mainWindow, {
          title: 'Import audio file',
          buttonLabel: 'Import audio File',
          filters: [{ name: 'Audio Files', extensions: ['mp3', 'wav', 'ogg'] }]
        })
        .then((result) => {
          if (result.canceled) return resolve()

          const filePath = result.filePaths[0]
          if (!filePath) return reject('Error locating path')

          const fileName = basename(pathArg)
          const targetSubdir = dirname(pathArg)
          const targetDirectory = join(appDataPath, targetSubdir)

          if (!fs.existsSync(targetDirectory)) {
            fs.mkdirSync(targetDirectory, { recursive: true })
          }

          const data = fs.readFileSync(filePath)
          // not saving the extension here so we can overwrite audio files having different extensions without extra logic
          fs.writeFile(join(targetDirectory, fileName), data, (err) => {
            if (err) return reject(err)
            resolve()
          })
        })
        .catch(reject)
    })
  })

  ipcMain.handle('get-fonts', async () => {
    const fonts = await fontList.getFonts()
    return fonts
  })

  ipcMain.handle('open-custom-flags-folder', async () => {
    const flagsPath = join(appDataPath, 'flags')

    if (!fs.existsSync(flagsPath)) {
      fs.mkdirSync(flagsPath, { recursive: true })
    }

    await shell.openPath(flagsPath)
  })

  ipcMain.handle('get-current-version', () => version)

  await gameHandler.connectYouTube()

  app.on('activate', () => {
    // On OS X it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows o
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

function getAssetsDir() {
  return app.isPackaged
    ? join(process.resourcesPath, 'assets')
    : join(process.cwd(), 'public', 'assets')
}

// Serve assets to 'asset:' file protocol
// Assets must be placed in the public folder
function serveAssets() {
  const assetDir = getAssetsDir()

  console.log('Serving assets from:', assetDir)

  protocol.handle('asset', (request) => {
    const url = new URL(request.url)
    const assetFile = join(assetDir, url.hostname, url.pathname === '/' ? '' : url.pathname)
    if (!assetFile.startsWith(assetDir)) {
      return new Response('Not Found', { status: 404 })
    }
    return net.fetch(pathToFileURL(assetFile).toString())
  })
}

async function serveFlags() {
  await loadCustomFlags()

  await protocol.handle('flag', async (request) => {
    const name = new URL(request.url).hostname
    const filePath = await findFlagFile(name)

    return net.fetch(`file://${filePath}`)
  })
}

/**
 * Returns the full path to a file or directory inside appData if it exists, otherwise returns false
 */
function getAppDataPathIfExists(subpath: string): string | false {
  const fullPath = subpath ? join(appDataPath, subpath) : appDataPath
  return fs.existsSync(fullPath) ? fullPath : false
}
