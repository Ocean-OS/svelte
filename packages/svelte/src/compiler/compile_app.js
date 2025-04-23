/** @import { AppCompileOptions, Scope, ValidatedCompileOptions } from '#compiler' */
/** @import { Declaration, ExportAllDeclaration, ExportDefaultDeclaration, ExportNamedDeclaration, ImportDeclaration, Node, Program } from 'estree' */
import { parse } from 'path';
import { readFileSync } from 'fs';
/** @import { LegacyRoot } from './types/legacy-nodes.js' */
/** @import { AST } from './public.js' */
import { walk as zimmerframe_walk } from 'zimmerframe';
import { convert } from './legacy.js';
import { parse as parse_acorn } from './phases/1-parse/acorn.js';
import { parse as _parse } from './phases/1-parse/index.js';
import { remove_typescript_nodes } from './phases/1-parse/remove_typescript_nodes.js';
import { analyze_component, analyze_module } from './phases/2-analyze/index.js';
import { transform_component, transform_module } from './phases/3-transform/index.js';
import { validate_component_options, validate_module_options } from './validate-options.js';
import * as state from './state.js';
import { remove_bom } from './utils/string.js';
import { print } from 'esrap';
import is_reference from 'is-reference';
import * as b from './utils/builders.js';
export { default as preprocess } from './preprocess/index.js';
/**
 * @param {AppCompileOptions} options
 */
function compileApp(options) {
	const { filename } = options;
	const entry = 'entry' in options ? options.entry : parse(filename).dir;
	const depth = 'depth' in options ? options.depth ?? 1 : 1;
	const source = remove_bom(readFileSync(filename, 'utf-8'));
	state.reset_warning_filter(options.warningFilter);
	const validated = validate_component_options(options, '');
	state.reset(source, validated);

	let parsed = _parse(source);

	const { customElement: customElementOptions, ...parsed_options } = parsed.options || {};

	/** @type {ValidatedCompileOptions} */
	const combined_options = {
		...validated,
		...parsed_options,
		customElementOptions
	};

	if (parsed.metadata.ts) {
		parsed = {
			...parsed,
			fragment: parsed.fragment && remove_typescript_nodes(parsed.fragment),
			instance: parsed.instance && remove_typescript_nodes(parsed.instance),
			module: parsed.module && remove_typescript_nodes(parsed.module)
		};
	}

	const analysis = analyze_component(parsed, source, combined_options);
	const result = transform_component(analysis, source, combined_options);
	if (depth < 1) return parse_acorn(result.js.code, false, false);
	/**
	 * @typedef {object} ComponentEntry
	 * @property {AST.Component} node
	 * @property {boolean} static
	 */
	/** @type {Map<ImportDeclaration, ComponentEntry[]>} */
	const imported_components = new Map();
	const walk_state = {
		scope: /** @type {Scope} */ (analysis.instance.scopes.get(parsed.fragment))
	};
	zimmerframe_walk(/** @type {AST.SvelteNode} */ (parsed.fragment), walk_state, {
		Component(node, context) {
			const binding = context.state.scope.get(
				node.name.includes('.') ? node.name.slice(0, node.name.indexOf('.')) : node.name
			);
			if (binding?.kind === 'normal' && binding.declaration_kind === 'import') {
				const declaration = /** @type {ImportDeclaration} */ (binding.initial);
				if (!imported_components.has(declaration)) {
					imported_components.set(declaration, []);
				}
				const is_static = node.attributes.every(
					(attr) =>
						attr.type === 'Attribute' &&
						(attr.value === true ||
							(Array.isArray(attr.value) &&
								attr.value.every(
									(part) =>
										part.type === 'Text' ||
										(part.type === 'ExpressionTag' &&
											context.state.scope.evaluate(part.expression).is_known)
								)) ||
							//@ts-expect-error
							/** @type {AST.ExpressionTag} */ (
								//@ts-expect-error
								attr.value.type === 'ExpressionTag' &&
									context.state.scope.evaluate(
										/** @type {AST.ExpressionTag} */ (attr.value).expression
									).is_known
							))
				);
				imported_components.get(declaration)?.push({
					node,
					static: is_static
				});
			}
			context.next();
		},
		Fragment(node, context) {
			const scope = /** @type {Scope} */ (analysis.instance.scopes.get(parsed.fragment));
			context.next(
				scope != null
					? {
							scope
						}
					: context.state
			);
		}
	});
	/** @type {Array<{source: string, resolved: string, declaration: ImportDeclaration }>} */
	const imports = [];
	for (const child of parsed.instance?.content.body ?? []) {
		if (child.type === 'ImportDeclaration' && imported_components.has(child)) {
			const source = /** @type {string} */ (child.source.value);
			const resolved = import.meta.resolve(source, entry);
			if (resolved.match(/\.svelte$/)) {
				imports.push({ source, resolved, declaration: child });
			}
		}
	}
	const js_ast = parse_acorn(result.js.code, false, false);
	const compiled_imports = [];
	for (const { resolved } of imports) {
		const source = readFileSync(resolved, 'utf-8');
		const compiled = compileApp({ ...options, depth: depth - 1 });
		let needs_async = false;
		/** @type {Array<ExportAllDeclaration|ExportNamedDeclaration|ExportDefaultDeclaration>} */
		const exported = [];
		const used_idents = new Set(); // since it'd be slower to create the scopes, we do this instead
		zimmerframe_walk(/** @type {Node} */ (compiled), null, {
			Identifier(node, context) {
				if (is_reference(node, /** @type {Node} */ (context.path.at(-1)))) {
					used_idents.add(node.name);
				}
			},
			FunctionExpression(node, context) {},
			ArrowFunctionExpression(node, context) {},
			FunctionDeclaration(node, context) {},
			AwaitExpression(node, context) {
				needs_async = true;
				context.next();
			},
			ExportNamedDeclaration(node, context) {
				exported.push(node);
				context.next();
			},
			ExportAllDeclaration(node, context) {
				exported.push(node);
				context.next();
			},
			ExportDefaultDeclaration(node, context) {
				exported.push(node);
				context.next();
			}
		});
		let exports_name = '$$exports';
		if (used_idents.has(exports_name)) {
			let counter = 0;
			while (used_idents.has(`${exports_name}_${++counter}`));
			used_idents.add((exports_name = `${exports_name}_${counter}`));
		}
		const export_replacements = new Map();
		for (const _export of exported) {
			switch (_export.type) {
				case 'ExportAllDeclaration': {
					break;
				}
				case 'ExportNamedDeclaration': {
					if (_export.declaration) {
					} else {
						const iife_body = [];
						for (const specifier of _export.specifiers) {
							iife_body.push(
								b.stmt(
									b.assignment(
										'=',
										b.member(
											b.id(exports_name),
											specifier.exported.type === 'Literal'
												? /** @type {string} */ (specifier.exported.value)
												: specifier.exported.name,
											specifier.exported.type === 'Literal'
										),
										specifier.local
									)
								)
							);
						}
						export_replacements.set(_export, b.call(b.arrow([], b.block(iife_body))));
					}
					break;
				}
				case 'ExportDefaultDeclaration': {
					break;
				}
			}
		}
	}
	return js_ast;
}

/**
 * @param {AppCompileOptions} options
 */
function compileApp_wrapper(options) {
	const compiled_ast = compileApp(options);
	return print(compiled_ast).code;
}

export { compileApp_wrapper as compileApp };
