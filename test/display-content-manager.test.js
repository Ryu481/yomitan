/*
 * Copyright (C) 2026  Yomitan Authors
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

import {JSDOM} from 'jsdom';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {DisplayContentManager} from '../ext/js/display/display-content-manager.js';

const media = {
    path: 'image.png',
    dictionary: 'test',
    mediaType: 'image/png',
    content: 'aW1hZ2U=',
    width: 1,
    height: 1,
};
/** @type {import('jsdom').DOMWindow} */
let window;
const getMedia = vi.fn(async () => [media]);
const drawMedia = vi.fn();

/** @returns {DisplayContentManager} */
function createManager() {
    const display = /** @type {import('../ext/js/display/display.js').Display} */ (/** @type {unknown} */ ({
        application: {api: {getMedia, drawMedia}},
    }));
    return new DisplayContentManager(display);
}

describe('DisplayContentManager media routing', () => {
    beforeEach(() => {
        window = new JSDOM('<!DOCTYPE html>').window;
        vi.stubGlobal('chrome', void 0);
        vi.stubGlobal('HTMLCanvasElement', window.HTMLCanvasElement);
        vi.stubGlobal('OffscreenCanvas', class {});
        vi.stubGlobal('createImageBitmap', vi.fn());
        Object.defineProperty(window.HTMLCanvasElement.prototype, 'transferControlToOffscreen', {
            value: vi.fn(),
            configurable: true,
        });
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-image');
        getMedia.mockClear();
        drawMedia.mockClear();
    });

    afterEach(() => {
        window.close();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    test('loads callbacks directly even when OffscreenCanvas is supported', async () => {
        const manager = createManager();
        const onUnload = vi.fn();
        expect(manager.supportsOffscreenCanvasMediaLoading()).toBe(true);
        const result = new Promise((resolve) => {
            manager.loadMedia(media.path, media.dictionary, (url) => resolve(url), onUnload);
        });
        await expect(result).resolves.toBe('blob:test-image');
        expect(getMedia).toHaveBeenCalledExactlyOnceWith([{path: media.path, dictionary: media.dictionary}]);
        expect(manager.loadMediaRequests).toHaveLength(0);
        manager.unloadAll();
        expect(onUnload).toHaveBeenCalledOnce();
    });

    test('queues canvas requests for the media drawing worker', async () => {
        const manager = createManager();
        const canvas = /** @type {OffscreenCanvas} */ (/** @type {unknown} */ ({width: 1, height: 1}));
        manager.loadMedia(media.path, media.dictionary, canvas);
        expect(manager.loadMediaRequests).toEqual([{path: media.path, dictionary: media.dictionary, canvas}]);
        expect(getMedia).not.toHaveBeenCalled();
        await manager.executeMediaRequests();
        expect(drawMedia).toHaveBeenCalledExactlyOnceWith([{path: media.path, dictionary: media.dictionary, canvas}], [canvas]);
        expect(manager.loadMediaRequests).toHaveLength(0);
    });

    test('uses direct images in Safari even when OffscreenCanvas APIs exist', async () => {
        vi.stubGlobal('chrome', {runtime: {getURL: () => 'safari-web-extension://test/'}});
        const manager = createManager();
        expect(manager.supportsOffscreenCanvasMediaLoading()).toBe(false);
        const result = new Promise((resolve) => {
            manager.loadMedia(media.path, media.dictionary, (url) => resolve(url));
        });
        await expect(result).resolves.toBe('blob:test-image');
        expect(manager.loadMediaRequests).toHaveLength(0);
    });
});
