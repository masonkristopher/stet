// The tar ustar layout: each entry is a 512-byte header block (name at offset 0, octal size at 124,
// Typeflag at 156) followed by the file content padded up to the next 512-byte boundary; two zeroed
// Blocks mark the end. Enough to pull one binary out of a cargo-dist release tarball, whose paths
// Are short (a `<target>/binary` pair) and whose only non-file entry is a leading pax/global header
// The walk skips by advancing over its content. GNU long-name and base-256 size extensions are not
// Needed for the single small binaries this reads.
const BLOCK = 512;
const decoder = new TextDecoder();

/**
 * The bytes of the first regular-file entry in an (already gunzipped) tar archive whose basename
 * equals `name`, or undefined when none matches.
 */
export function extractTarEntry(tar: Uint8Array, name: string): Uint8Array | undefined {
  for (let offset = 0; offset + BLOCK <= tar.length;) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header[0] === 0) {
      return undefined;
    }
    const nameField = decoder.decode(header.subarray(0, 100));
    const nul = nameField.indexOf("\0");
    const path = nul === -1 ? nameField : nameField.slice(0, nul);
    // `trim()` leaves the NUL padding of a malformed all-zero-byte size field, so parseInt can still
    // Return NaN; bail rather than let it flow into `offset` and silently mis-terminate the walk.
    const size = Number.parseInt(decoder.decode(header.subarray(124, 136)).trim() || "0", 8);
    if (Number.isNaN(size)) {
      return undefined;
    }
    const content = offset + BLOCK;
    // Typeflag '0' (0x30) or the legacy NUL both denote a regular file; anything else (directories,
    // The pax header) is skipped, its content advanced over the same way.
    const isFile = header[156] === 0x30 || header[156] === 0;
    if (isFile && path.slice(path.lastIndexOf("/") + 1) === name) {
      return tar.subarray(content, content + size);
    }
    offset = content + Math.ceil(size / BLOCK) * BLOCK;
  }
  return undefined;
}
