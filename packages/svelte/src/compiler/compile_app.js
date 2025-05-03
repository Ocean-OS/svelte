/** @import { AppCompileOptions, AppCompileResult, Scope, ValidatedCompileOptions } from '#compiler' */
/** @import { BaseModuleSpecifier, BlockStatement, CallExpression, Declaration, ExportAllDeclaration, ExportDefaultDeclaration, ExportNamedDeclaration, Expression, FunctionDeclaration, Identifier, ImportDeclaration, ImportSpecifier, Literal, Node, ObjectExpression, Pattern, Program, Property, Statement, VariableDeclaration } from 'estree' */
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
import {
	validate_compileapp_options,
	validate_component_options,
	validate_module_options
} from './validate-options.js';
import * as state from './state.js';
import { remove_bom } from './utils/string.js';
import { print } from 'esrap';
import is_reference from 'is-reference';
import * as b from './utils/builders.js';
import { extract_identifiers } from './utils/ast.js';
import { client_component } from './phases/3-transform/client/transform-client.js';
import { build_template_chunk } from './phases/3-transform/client/visitors/shared/utils.js';
import { get_rune } from './phases/scope.js';
export { default as preprocess } from './preprocess/index.js';

/**
 * @param {ImportDeclaration['specifiers']} specifiers
 * @returns {Pattern}
 */
function to_pattern(specifiers) {
	/** @type {Property[]} */
	const properties = [];
	for (const specifier of specifiers) {
		switch (specifier.type) {
			case 'ImportSpecifier': {
				const key = specifier.imported;
				const value = specifier.local;
				properties.push(b.prop('init', key, value));
				break;
			}
			case 'ImportDefaultSpecifier': {
				const key = b.id('default');
				const value = specifier.local;
				properties.push(b.prop('init', key, value));
				break;
			}
			case 'ImportNamespaceSpecifier': {
				return specifier.local;
			}
		}
	}
	return b.object_pattern(properties);
}

/**
 * Only returns true if the passed component is static, excluding props.
 * Only regular elements, text, components, and expressions are allowed. No blocks or snippets, etc.
 * @param {import('./phases/types.js').ComponentAnalysis} analysis
 */
function is_static_component(analysis) {
	if (
		!(
			analysis.instance.ast.body.length === 1 &&
			analysis.instance.ast.body[0].type === 'VariableDeclaration' &&
			analysis.instance.ast.body[0].declarations.length === 1 &&
			analysis.instance.ast.body[0].declarations[0].init &&
			get_rune(analysis.instance.ast.body[0].declarations[0].init, analysis.instance.scope) ===
				'$props' &&
			analysis.instance.ast.body[0].declarations[0].id.type === 'ObjectPattern' &&
			analysis.instance.ast.body[0].declarations[0].id.properties.every(
				(property) =>
					property.type === 'Property' &&
					property.value.type === 'Identifier' &&
					!analysis.instance.scope.get(property.value.name)?.updated
			) &&
			analysis.template.ast.nodes.every((node) =>
				/** @type {AST.Fragment['nodes'][number]['type'][]} */ ([
					'Comment',
					'Component',
					'ExpressionTag',
					'HtmlTag',
					'RegularElement',
					'Text'
				]).includes(node.type)
			)
		)
	)
		return false;
	if (analysis.template.ast.nodes.some((node) => node.type === 'RegularElement')) {
		for (const node of analysis.template.ast.nodes) {
			if (node.type !== 'RegularElement' && node.type !== 'Component') continue;

			let is_static = true;
			/**
			 * @param {AST.SvelteNode} _
			 * @param {import('zimmerframe').Context<AST.SvelteNode, null>} context
			 */
			const stop = (_, context) => {
				is_static = false;
				context.stop();
			};
			zimmerframe_walk(/** @type {AST.SvelteNode} */ (node.fragment), null, {
				IfBlock: stop,
				EachBlock: stop,
				SnippetBlock: stop,
				SlotElement: stop,
				KeyBlock: stop,
				AwaitBlock: stop,
				SvelteBody: stop,
				SvelteBoundary: stop,
				SvelteComponent: stop,
				SvelteDocument: stop,
				SvelteElement: stop,
				SvelteFragment: stop,
				SvelteHead: stop,
				SvelteOptions: stop,
				SvelteSelf: stop,
				SvelteWindow: stop,
				RenderTag: stop
			});
			if (!is_static) {
				return false;
			}
		}
	}
	return true;
}

/**
 * Here's my current thought process for this:
 * 1. We should only assume that imports whose resolved path ends with `.svelte` are actually components
 * 2. We should only use static components for optimization
 * Here's a few ideas/notes for how this can be implemented.
 * - Take component imports, and if they are truly static (only consisting of a template and a `$.append` call), inline them
 * - Take component imports, and if they take props but are otherwise static, and all references to them have static props, inline them
 */

/**
 * @param {string} filename
 * @param {AppCompileOptions} options
 * @param {AppCompileResult} [current_analysis]
 * @returns {[Program, import('./phases/types.js').ComponentAnalysis, AppCompileResult]}
 */
function compileApp(
	filename,
	options = {},
	current_analysis = {
		inlined: {
			imports: [],
			components: []
		},
		warnings: [],
		js: /** @type {AppCompileResult['js']} */ (/** @type {unknown} */ (null)) // this is assigned later
	}
) {
	const {
		entry = parse(filename).dir,
		depth = 1,
		...component_options
	} = validate_compileapp_options(options, '');
	const source = remove_bom(readFileSync(filename, 'utf-8'));
	state.reset_warning_filter(component_options.warningFilter);
	const validated = validate_component_options(component_options, '');
	if (validated.generate !== 'client') throw new Error('not available yet');
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
	current_analysis.warnings.push(
		...result.warnings.map((warning) => ({
			filename,
			...warning
		}))
	);
	if (depth < 1) return [parse_acorn(result.js.code, false, false), analysis, current_analysis];
	/**
	 * @typedef {object} ComponentEntry
	 * @property {AST.Component} node
	 * @property {boolean} static
	 * @property {Scope} scope
	 */
	/** @type {Map<ImportDeclaration, ComponentEntry[]>} */
	const imported_components = new Map();
	const scope = /** @type {Scope} */ (analysis.module.scope);
	const walk_state = {
		scope
	};
	zimmerframe_walk(/** @type {AST.SvelteNode} */ (parsed.fragment), walk_state, {
		Component(node, context) {
			if (node.name.includes('.')) {
				context.next();
				return;
			}
			const binding = context.state.scope.get(node.name);
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
							(!Array.isArray(attr.value) &&
								attr.value.type === 'ExpressionTag' &&
								context.state.scope.evaluate(
									/** @type {AST.ExpressionTag} */ (attr.value).expression
								).is_known))
				);
				imported_components.get(declaration)?.push({
					node,
					static: is_static,
					scope: context.state.scope
				});
			}
			context.next();
		},
		Fragment(node, context) {
			const scope = /** @type {Scope} */ (
				analysis.instance.scopes.get(node) ?? analysis.module.scopes.get(node)
			);
			context.next({ scope: scope ?? context.state.scope });
		}
	});
	/** @param {string} resolved */
	function normalize_resolved(resolved) {
		return resolved.replace(/^file\:\/{3}/, '');
	}
	/**
	 * @param {string} specifier
	 * @param {string | URL | undefined} [parent]
	 */
	function resolve(specifier, parent) {
		return normalize_resolved(import.meta.resolve(specifier, parent));
	}
	/** @type {Array<{source: string, resolved: string, declaration: ImportDeclaration, components: ComponentEntry[] | undefined }>} */
	const imports = [];
	const existing_imports = [];
	for (const child of parsed.instance?.content.body ?? []) {
		if (child.type === 'ImportDeclaration' && imported_components.has(child)) {
			const source = /** @type {string} */ (child.source.value);
			const resolved = resolve(source, entry);
			if (resolved.match(/\.svelte$/)) {
				imports.push({
					source,
					resolved,
					declaration: child,
					components: imported_components.get(child)
				});
			}
			existing_imports.push({ resolved, declaration: child });
		}
	}
	const js_ast = parse_acorn(result.js.code, false, false);
	/**
	 * @param {ImportDeclaration} a
	 * @param {ImportDeclaration} b
	 */
	function is_same_importdeclaration(a, b) {
		if (
			resolve(/** @type {string} */ (a.source.value)) !==
			resolve(/** @type {string} */ (b.source.value))
		) {
			return false;
		}
		if (a.specifiers.length !== b.specifiers.length) {
			return false;
		}
		for (let index = 0; index < a.specifiers.length; index++) {
			const a_specifier = a.specifiers[index];
			const b_specifier = b.specifiers[index];
			if (a_specifier.type !== b_specifier.type) {
				return false;
			}
			if (a_specifier.local.name !== b_specifier.local.name) {
				return false;
			}
			if (a_specifier.type === 'ImportSpecifier' && a_specifier.type === b_specifier.type) {
				if (a_specifier.imported.type !== b_specifier.imported.type) {
					return false;
				} else {
					if (a_specifier.imported.type === 'Identifier') {
						if (
							a_specifier.imported.name !== /** @type {Identifier} */ (b_specifier.imported).name
						) {
							return false;
						}
					} else {
						if (
							a_specifier.imported.value !== /** @type {Literal} */ (b_specifier.imported).value
						) {
							return false;
						}
					}
				}
			}
		}
		return true;
	}
	for (const child of js_ast.body) {
		if (child.type === 'ImportDeclaration') {
			const found = imports.find(({ declaration }) =>
				is_same_importdeclaration(child, declaration)
			);
			if (found) {
				imported_components.set(
					child,
					/** @type {ComponentEntry[]} */ (imported_components.get(found.declaration))
				);
				found.declaration = child;
			}
		}
	}
	const result_body = [...js_ast.body];
	/** @type {Program} */
	let result_ast = {
		type: 'Program',
		body: result_body,
		sourceType: 'module'
	};
	for (const { resolved, declaration, components = [] } of imports) {
		const [compiled, import_analysis] = compileApp(
			resolved,
			{
				...options,
				depth: depth - 1
			},
			current_analysis
		);
		if (
			components.every(({ static: is_static }) => is_static) &&
			declaration.specifiers.length === 1 &&
			declaration.specifiers[0].type === 'ImportDefaultSpecifier' &&
			import_analysis.module.ast.body.length === 0
		) {
			if (
				import_analysis.template.ast.metadata.dynamic === false &&
				import_analysis.instance.ast.body.length === 0 &&
				imported_components.get(declaration) &&
				imported_components.get(declaration)?.every(({ node }) => node.attributes.length === 0)
			) {
				/** @type {VariableDeclaration} */
				const template_declaration = /** @type {VariableDeclaration} */ (
					compiled.body.find(
						(node) =>
							node.type === 'VariableDeclaration' &&
							node.declarations.length === 1 &&
							node.declarations[0]?.init?.type === 'CallExpression' &&
							((node.declarations[0].init.callee.type === 'MemberExpression' &&
								node.declarations[0].init.callee.object.type === 'Identifier' &&
								node.declarations[0].init.callee.object.name === '$' &&
								node.declarations[0].init.callee.property.type === 'Identifier' &&
								node.declarations[0].init.callee.property.name === 'template') ||
								(node.declarations[0].init.callee.type === 'Identifier' &&
									node.declarations[0].init.callee.name === '$.template'))
					)
				);
				const component_callee = declaration.specifiers[0].local.name;
				current_analysis.inlined.components.push(resolved);
				if (template_declaration) {
					const template_id = scope.generate('$$imported_root');
					result_body[result_body.indexOf(declaration)] = b.var(
						template_id,
						/** @type {CallExpression} */ (template_declaration.declarations[0].init)
					);
					result_ast = /** @type {Program} */ (
						zimmerframe_walk(/** @type {Node} */ (result_ast), null, {
							CallExpression(node, context) {
								if (
									node.callee.type === 'Identifier' &&
									node.callee.name === component_callee &&
									context.path.at(-1)?.type === 'ExpressionStatement' &&
									node.arguments.length === 2 &&
									node.arguments[1]?.type === 'ObjectExpression' &&
									node.arguments[1].properties.length === 0
								) {
									return b.call(`$.append`, b.call(template_id), node.arguments[0]);
								}
								context.next();
							}
						})
					);
				} else {
					result_ast = /** @type {Program} */ (
						zimmerframe_walk(/** @type {Node} */ (result_ast), null, {
							ExpressionStatement(stmt) {
								const { expression: node } = stmt;
								if (
									node.type === 'CallExpression' &&
									node.callee.type === 'Identifier' &&
									node.callee.name === component_callee &&
									node.arguments.length === 1
								) {
									return b.empty;
								}
							}
						})
					);
				}
				continue;
			} else if (is_static_component(import_analysis)) {
				const component_callee = declaration.specifiers[0].local.name;
				const component_instance = /** @type {ExportDefaultDeclaration} */ (
					compiled.body.find(
						(node) =>
							node.type === 'ExportDefaultDeclaration' &&
							node.declaration?.type === 'FunctionDeclaration'
					)
				)?.declaration;
				result_ast = /** @type {Program} */ (
					zimmerframe_walk(/** @type {Node} */ (result_ast), null, {
						CallExpression(node) {
							if (
								node.type === 'CallExpression' &&
								node.callee.type === 'Identifier' &&
								node.callee.name === component_callee
							) {
								const $$props = Object.create(null);
								const props =
									/** @type {ObjectExpression & {properties: (Property & {computed: false})[]}} */ (
										node.arguments[1]
									);
								for (const property of props.properties) {
									/** @type {string} */
									const key = /** @type {string} */ (
										property.key.type === 'Literal'
											? property.key.value
											: /** @type {Identifier} */ (property.key).name
									);
									if (property.kind === 'init') {
										$$props[key] = property.value;
									}
								}
								const anchor = node.arguments[0];
								const transformed_component_instance = zimmerframe_walk(
									/** @type {Node} */ (
										/** @type {FunctionDeclaration} */ (component_instance).body
									),
									null,
									{
										MemberExpression(node, context) {
											if (
												node.object.type === 'Identifier' &&
												node.object.name === '$$props' &&
												node.property.type === 'Identifier'
											) {
												const key = node.property.name;
												if (key in $$props) {
													return $$props[key];
												}
												return b.void0;
											}
											context.next();
										},
										Identifier(node, context) {
											if (
												is_reference(node, /** @type {Node} */ (context.path.at(-1))) &&
												node.name === '$$anchor'
											) {
												return anchor;
											}
										}
									}
								);
								return transformed_component_instance;
							}
						}
					})
				);
			}
		}
		let needs_async = false;
		let exports_name = import_analysis.instance.scope.generate('$$exports');
		const destructuring_pattern = to_pattern(declaration.specifiers);
		const top_level_imports = [];
		const body = [];
		/** @type {Pattern[]} */
		const params = [];
		/** @type {Expression[]} */
		const args = [];
		for (const child of /** @type {Program} */ (compiled).body) {
			switch (child.type) {
				case 'ExportAllDeclaration': {
					const local = scope.generate(`$$import`);
					top_level_imports.push(
						b.import_all(local, resolve(/** @type {string} */ (child.source.value), resolved))
					);
					if (child.exported === null) {
						body.push(
							b.stmt(
								b.call(b.member_id('globalThis.Object.assign'), b.id(exports_name), b.id(local))
							)
						);
					} else {
						body.push(
							b.stmt(
								b.assignment(
									'=',
									b.member(b.id(exports_name), child.exported, child.exported.type === 'Literal'),
									b.id(local)
								)
							)
						);
					}
					break;
				}
				case 'ExportDefaultDeclaration': {
					if (
						child.declaration.type === 'ClassDeclaration' ||
						child.declaration.type === 'FunctionDeclaration'
					) {
						if (child.declaration.id) {
							body.push(child.declaration);
							body.push(
								b.stmt(
									b.assignment('=', b.member(b.id(exports_name), 'default'), child.declaration.id)
								)
							);
						} else {
							const expression =
								child.declaration.type === 'ClassDeclaration'
									? b.class_expression(child.declaration.body)
									: b.function(null, child.declaration.params, child.declaration.body);
							body.push(
								b.stmt(b.assignment('=', b.member(b.id(exports_name), 'default'), expression))
							);
						}
					} else {
						body.push(
							b.stmt(b.assignment('=', b.member(b.id(exports_name), 'default'), child.declaration))
						);
					}
					break;
				}
				case 'ExportNamedDeclaration': {
					if (child.declaration) {
						body.push(child.declaration);
						if (
							child.declaration.type === 'FunctionDeclaration' ||
							child.declaration.type === 'ClassDeclaration'
						) {
							body.push(
								b.stmt(
									b.assignment(
										'=',
										b.member(b.id(exports_name), child.declaration.id),
										child.declaration.id
									)
								)
							);
						} else {
							for (const declaration of child.declaration.declarations) {
								for (const identifier of extract_identifiers(declaration.id)) {
									body.push(
										b.stmt(b.assignment('=', b.member(b.id(exports_name), identifier), identifier))
									);
								}
							}
						}
					} else if (child.specifiers.length) {
						for (const specifier of child.specifiers) {
							body.push(
								b.stmt(
									b.assignment(
										'=',
										b.member(b.id(exports_name), specifier.exported),
										specifier.local
									)
								)
							);
						}
					}
					break;
				}
				case 'ImportDeclaration': {
					if (
						result_body.find(
							(node) => node.type === 'ImportDeclaration' && is_same_importdeclaration(child, node)
						)
					) {
						break;
					}
					const res = [];
					for (const specifier of child.specifiers) {
						let name = scope.generate(`$$import_${specifier.local.name}`);
						res.push({ ...specifier, local: b.id(name) });
						params.push(specifier.local);
						args.push(b.id(name));
					}
					top_level_imports.push(b.import_declaration(res, child.source));
					break;
				}
				default:
					body.push(child);
			}
		}
		body.push(b.return(b.id(exports_name)));
		current_analysis.inlined.imports.push(resolved);
		result_body[result_body.indexOf(declaration)] = b.var(
			destructuring_pattern,
			b.call(b.arrow(params, b.block(/** @type {BlockStatement['body']} */ (body))), ...args)
		);
		result_body.unshift(...top_level_imports);
	}
	return [result_ast, analysis, current_analysis];
}

/**
 * @param {string} filename
 * @param {AppCompileOptions} [options]
 * @returns {AppCompileResult}
 */
function compileApp_wrapper(filename, options) {
	const compiled_ast = compileApp(filename, options);
	const result = compiled_ast[2];
	result.js = print(compiled_ast[0]);
	return result;
}

export { compileApp_wrapper as compileApp };
