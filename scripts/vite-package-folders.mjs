// A Vite plugin that serves folders of an installed package at fixed paths, in the dev server and
// in the build. The PDF viewer fetches its character maps, standard fonts and decoders by name
// while it reads a document, so they cannot be bundled as imports.
import { createReadStream, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const types = { wasm: 'application/wasm', js: 'text/javascript' };

/** @param {Record<string, { from: string, skip?: RegExp }>} folders Mount path to source folder. */
export function packageFolders(folders) {
  const mounts = Object.entries(folders).map(([mount, { from, skip }]) => ({
    mount,
    root: resolve(from),
    skip,
  }));
  return {
    name: 'package-folders',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = decodeURIComponent((request.url ?? '').split('?')[0]);
        const found = mounts.find(({ mount }) => path.startsWith(mount));
        if (!found) return next();
        const file = resolve(found.root, path.slice(found.mount.length));
        // Only files directly inside the folder: a path cannot climb out of it.
        const inside = file.startsWith(found.root + sep);
        if (
          !inside ||
          found.skip?.test(file) ||
          !statSync(file, { throwIfNoEntry: false })?.isFile()
        )
          return next();
        response.setHeader(
          'Content-Type',
          types[file.split('.').pop() ?? ''] ?? 'application/octet-stream',
        );
        createReadStream(file).pipe(response);
      });
    },
    generateBundle() {
      for (const { mount, root, skip } of mounts)
        for (const name of readdirSync(root))
          if (!skip?.test(name) && statSync(join(root, name)).isFile())
            this.emitFile({
              type: 'asset',
              fileName: `${mount.slice(1)}${name}`,
              source: readFileSync(join(root, name)),
            });
    },
  };
}
