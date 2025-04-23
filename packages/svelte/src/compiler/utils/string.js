/**
 * @param {string[]} strings
 * @param {string} conjunction
 */
export function list(strings, conjunction = 'or') {
	if (strings.length === 1) return strings[0];
	if (strings.length === 2) return `${strings[0]} ${conjunction} ${strings[1]}`;
	return `${strings.slice(0, -1).join(', ')} ${conjunction} ${strings[strings.length - 1]}`;
}

/**
 * Remove the byte order mark from a string if it's present since it would mess with our template generation logic
 * @param {string} source
 */
export function remove_bom(source) {
	if (source.charCodeAt(0) === 0xfeff) {
		return source.slice(1);
	}
	return source;
}