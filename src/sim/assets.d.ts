/** Импорт файла как адреса (Vite): `import url from './osm.bin?url'`. */
declare module '*.bin?url' {
  const url: string;
  export default url;
}
