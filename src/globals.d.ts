// Values that the build itself puts in place. Declared here rather than inside a
// module so that main, the preload and the renderer all see the same one.
//
// __BUILD__ is replaced by electron.vite.config.ts with the commit and time the
// bundle was built. It is read only by the main process, where `typeof` guards
// against a bundle that was built without it.
declare const __BUILD__: string;
