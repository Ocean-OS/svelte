import {compile} from './index.js';
import {writeFileSync as write, readFileSync as read} from 'fs';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { rollup } from 'rollup';
import virtual from '@rollup/plugin-virtual';
import { nodeResolve } from '@rollup/plugin-node-resolve';
const pkg = JSON.parse(fs.readFileSync('../../package.json', 'utf8'));
/**
 * @param {string} entry
 */
async function bundle_code(entry) {
    const bundle = await rollup({
        input: '__entry__',
        plugins: [
            virtual({
                __entry__: entry
            }),
            {
                name: 'resolve-svelte',
                resolveId(importee) {
                    if (importee.startsWith('svelte')) {
                        const entry = pkg.exports[importee.replace('svelte', '.')];
                        return path.resolve('../..', entry.browser ?? entry.default);
                    }
                }
            },
            nodeResolve({
                exportConditions: ['production', 'import', 'browser', 'default']
            })
        ],
        onwarn: (warning, handle) => {
            if (warning.code !== 'EMPTY_BUNDLE' && warning.code !== 'CIRCULAR_DEPENDENCY') {
                handle(warning);
            }
        }
    });

    const { output } = await bundle.generate({});

    if (output.length > 1) {
        throw new Error('errr what');
    }

    return output[0].code.trim();
}
write('./res.js', await bundle_code(compile(read('./test.svelte', 'utf-8'), {
    warningFilter() {
        return false
    }
}).js.code));
