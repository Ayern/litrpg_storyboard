// Copying the story bible. The text is parked here so a capture can show that
// something was copied without needing a real clipboard.

export let lastCopied = '';

export async function writeText(text: string) {
  lastCopied = text;
}

export default { writeText };
