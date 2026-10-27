// The file picker. There is no filesystem behind the harness, so a pick is
// answered as a cancellation, which is a state the app already handles.

export async function open() {
  return null;
}

export async function save() {
  return null;
}

export default { open, save };
