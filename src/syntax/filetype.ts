import { languages } from "./languages";

const filetypeByExtension = new Map(
  languages.flatMap((language) =>
    language.extensions.map((extension) => [extension, language.filetype]),
  ),
);

export function supportedFiletypeFor(path: string) {
  const match = /\.[^.]+$/.exec(path);
  if (match === null) {
    return undefined;
  }

  return filetypeByExtension.get(match[0]);
}

export function filetypeFor(path: string) {
  return supportedFiletypeFor(path) ?? "text";
}
