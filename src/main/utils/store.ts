import ElectronStore from 'electron-store'

type Schema = {
  settings: Settings
}

export const store = new ElectronStore<Schema>()
