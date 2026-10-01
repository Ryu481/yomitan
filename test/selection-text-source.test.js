/*
 * Copyright (C) 2023-2026  Yomitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {expect, vi} from 'vitest';
import {SelectionTextSource} from '../ext/js/app/frontend.js';
import {TextSourceGenerator} from '../ext/js/dom/text-source-generator.js';
import {TextScanner} from '../ext/js/language/text-scanner.js';
import {createDomTest} from './fixtures/dom-test.js';

const domTest = createDomTest();

domTest('looks up Safari Live Text without requiring a DOM range', async ({window}) => {
    const termsFind = vi.fn(async () => ({dictionaryEntries: [], originalTextLength: 0}));
    const scanner = new TextScanner({
        api: /** @type {import('../ext/js/comm/api.js').API} */ (/** @type {unknown} */ ({termsFind})),
        node: /** @type {Window} */ (/** @type {unknown} */ (window)),
        getSearchContext: () => ({optionsContext: {depth: 0, url: 'https://example.com'}, detail: {documentTitle: 'OCR page'}}),
        textSourceGenerator: new TextSourceGenerator(),
        searchTerms: true,
        browser: 'safari',
    });
    scanner.setOptions({scanLength: 32});
    const source = new SelectionTextSource('尊敬する', [new DOMRect(10, 20, 30, 40)]);
    const searchError = vi.fn();
    const searchEmpty = vi.fn();
    scanner.on('searchError', searchError);
    scanner.on('searchEmpty', searchEmpty);

    await scanner.search(source, {focus: true, restoreSelection: true});

    expect(termsFind).toHaveBeenCalledWith('尊敬する', {}, expect.objectContaining({url: 'https://example.com'}));
    expect(searchError).not.toHaveBeenCalled();
    expect(searchEmpty).toHaveBeenCalledTimes(1);
    expect(source.getRects()).toEqual([new DOMRect(10, 20, 30, 40)]);
});
