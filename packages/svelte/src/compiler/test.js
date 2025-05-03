import { compileApp } from "#compiler";
console.log(compileApp('./a.svelte').js.code);