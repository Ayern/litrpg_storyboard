// The window the app asks for when it is quitting. The harness is a plain
// browser page, so the app never reaches this: it checks for the Tauri
// internals first. It exists so the import resolves.

export function getCurrentWindow() {
  return {
    label: 'screenshot-harness',
    onCloseRequested: async (_handler: unknown) => () => {},
    destroy: async () => {},
    setTitle: async (_title: string) => {},
  };
}

export default { getCurrentWindow };
