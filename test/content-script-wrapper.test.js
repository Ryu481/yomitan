/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2019-2022  Yomichan Authors
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

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

const loadKey = Symbol.for('yomitan.contentScriptMainLoaded');
const wrapperScriptPath = '../ext/js/app/content-script-wrapper.js';
const mainFactory = vi.fn(() => ({}));
const getURL = vi.fn(() => new URL('../ext/js/app/content-script-main.js', import.meta.url).pathname);

/** @returns {Promise<unknown>} */
function importWrapper() {
    // eslint-disable-next-line no-unsanitized/method
    return import(wrapperScriptPath);
}

/** */
async function loadWrapper() {
    vi.resetModules();
    await importWrapper();
    await vi.dynamicImportSettled();
}

describe('content script wrapper', () => {
    beforeEach(() => {
        Reflect.deleteProperty(globalThis, loadKey);
        vi.stubGlobal('chrome', {runtime: {getURL}});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        getURL.mockClear();
        mainFactory.mockReset();
        mainFactory.mockReturnValue({});
        vi.doMock('../ext/js/app/content-script-main.js', mainFactory);
    });

    afterEach(() => {
        Reflect.deleteProperty(globalThis, loadKey);
        vi.doUnmock('../ext/js/app/content-script-main.js');
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    test('loads once despite repeated injection', async () => {
        await loadWrapper();
        await loadWrapper();

        expect(getURL).toHaveBeenCalledExactlyOnceWith('js/app/content-script-main.js');
        expect(mainFactory).toHaveBeenCalledTimes(1);
        expect(Reflect.get(globalThis, loadKey)).toBe(true);
        expect(console.warn).not.toHaveBeenCalled();
    });

    test('prevents duplicate loading while the import is pending', async () => {
        let finishLoading = () => {};
        const pendingImport = new Promise((resolve) => {
            finishLoading = () => resolve({});
        });
        mainFactory.mockImplementationOnce(async () => await pendingImport);

        vi.resetModules();
        await importWrapper();
        vi.resetModules();
        await importWrapper();

        expect(getURL).toHaveBeenCalledTimes(1);
        finishLoading();
        await vi.dynamicImportSettled();
        expect(mainFactory).toHaveBeenCalledTimes(1);
        expect(Reflect.get(globalThis, loadKey)).toBe(true);
    });

    test('handles a failed import and allows reinjection', async () => {
        mainFactory.mockImplementationOnce(() => { throw new TypeError('Importing a module script failed.'); });
        await loadWrapper();

        expect(Reflect.get(globalThis, loadKey)).toBe(false);
        expect(console.warn).toHaveBeenCalledTimes(1);
        await loadWrapper();

        expect(getURL).toHaveBeenCalledTimes(2);
        expect(mainFactory).toHaveBeenCalledTimes(2);
        expect(Reflect.get(globalThis, loadKey)).toBe(true);
    });

    test('handles runtime URL failures and allows reinjection', async () => {
        const error = new Error('Extension context invalidated');
        getURL.mockImplementationOnce(() => { throw error; });
        await loadWrapper();

        expect(Reflect.get(globalThis, loadKey)).toBe(false);
        expect(console.warn).toHaveBeenCalledWith('Yomitan content script could not be loaded', error);
        await loadWrapper();
        expect(mainFactory).toHaveBeenCalledTimes(1);
        expect(Reflect.get(globalThis, loadKey)).toBe(true);
    });
});
