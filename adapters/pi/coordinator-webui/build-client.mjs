import { createRequire } from "node:module";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

/** Compile the already-installed, version-checked Marked parser into private plugin artifacts; never download or vendor source. */
export async function buildClient({ webPackage, pluginDirectory }) {
 const require=createRequire(join(webPackage,"package.json"));
 const markedEntry=require.resolve("marked"),esbuild=require("esbuild");
 const markedRoot=dirname(dirname(markedEntry));
 const marked=JSON.parse(await readFile(join(markedRoot,"package.json"),"utf8"));
 if(marked.version!=="18.0.11"||esbuild.version!=="0.28.2")throw Error("Coordinator UI build requires tested Marked 18.0.11 and esbuild 0.28.2; installed dependencies were not modified");
 const directory=join(pluginDirectory,"client/vendor");await mkdir(directory,{recursive:true,mode:0o700});
 await esbuild.build({entryPoints:[markedEntry],outfile:join(directory,"marked.mjs"),bundle:true,format:"esm",platform:"browser",target:"es2022",minify:true,legalComments:"eof",banner:{js:"/*! Marked 18.0.11 | MIT | https://github.com/markedjs/marked */"}});
 await writeFile(join(directory,"marked-LICENSE.md"),await readFile(join(markedRoot,"LICENSE")),{mode:0o600});
 await writeFile(join(directory,"components.json"),JSON.stringify({marked:marked.version,esbuild:esbuild.version,source:"installed pi-web-ui dependencies",license:"MIT"}),{mode:0o600});
 return {marked:marked.version,esbuild:esbuild.version};
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 await buildClient({webPackage:process.env.PI_WEB_UI_PACKAGE||join(homedir(),".pi/agent/npm/node_modules/pi-web-ui"),pluginDirectory:dirname(fileURLToPath(import.meta.url))});
}
