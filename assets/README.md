# Orbit application icons

`orbit-icon.svg` is the application icon master. Its clipping path follows the
approved ribbons and both openings, removing the background while preserving the
white ribbon. The square viewBox centers the artwork with balanced padding.
`orbit-icon-source.png` preserves the original approved artwork unchanged and is
referenced by the master; it is not used directly as an application icon.

Run `node scripts/update-app-icons.mjs` to refresh all sizes without building the app.
When replacing the artwork, update both the original image and the master's
clipping path/viewBox before regenerating the exports.

- `app-icon.png`: 1024px desktop and startup image.
- `app-icon-small.png`: 128px source for the shared `OrbitIcon` UI component.
- `app-icon.ico`: 16, 24, 32, 48, 64, 128, and 256px Windows application/installer frames.
- `src/app/favicon.ico`, `icon.png`, and `apple-icon.png`: Next.js metadata icons.
- Browser extension icons: 16, 32, 48, and 128px inside its packaged runtime.

The existing SVG paths are self-contained wrappers of the same raster artwork;
they are not alternate vector designs. All exported assets retain alpha transparency,
including the Windows ICO bitmap frames and their fallback transparency masks.
