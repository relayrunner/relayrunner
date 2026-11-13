// Vite's `?raw` imports, which tests use to read a text file.
declare module "*?raw" {
  const text: string;
  export default text;
}
