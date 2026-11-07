/** macOS draws its own window buttons and uses Command where other systems use Ctrl. */
export const isMac = /Macintosh|Mac OS X/.test(navigator.userAgent);
