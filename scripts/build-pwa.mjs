import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=new URL('../dist/',import.meta.url);
const files=await readdir(root,{recursive:true,withFileTypes:true});
const paths=files.filter(file=>file.isFile()).map(file=>join(file.parentPath,file.name)).filter(path=>/\.(?:html|js|css|svg|png|webmanifest|woff2?)$/.test(path)&&!path.endsWith(`${sep}sw.js`)).sort();
const hash=createHash('sha256');
const urls=[];
const sw=await readFile(new URL('sw.js',root),'utf8');
hash.update(sw);
hash.update(await readFile(new URL('_headers',root),'utf8'));
for(const path of paths) {
  const url='/'+relative(fileURLToPath(root),path).split(sep).join('/');
  urls.push(url);hash.update(url);hash.update(await readFile(path));
}
const revision=hash.digest('hex').slice(0,16);
const documentHash=createHash('sha256').update(await readFile(new URL('index.html',root))).digest('hex');
await writeFile(new URL('sw.js',root),`self.__HEARTH_PRECACHE = ${JSON.stringify(urls)};\nself.__HEARTH_REVISION = ${JSON.stringify(revision)};\nself.__HEARTH_DOCUMENT_HASH = ${JSON.stringify(documentHash)};\n${sw}`);
console.log(`Prepared offline shell ${revision} (${urls.length} public assets).`);
