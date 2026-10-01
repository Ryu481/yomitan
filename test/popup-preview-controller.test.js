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

import {afterEach, describe, expect, vi} from 'vitest';
import {PopupPreviewController} from '../ext/js/pages/settings/popup-preview-controller.js';
import {createDomTest} from './fixtures/dom-test.js';

const domTest = createDomTest();
const origin = 'safari-web-extension://extension';

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

/**
 * @param {import('jsdom').DOMWindow} window
 * @returns {{invoke: PopupPreviewController['_invoke'], onFrameMessage: PopupPreviewController['_onFrameMessage'], frameWindow: Window}}
 */
function createController(window) {
    window.document.body.innerHTML = '<iframe id="popup-preview-frame"></iframe><textarea id="custom-popup-css"></textarea><textarea id="custom-popup-outer-css"></textarea><div class="preview-frame-container"></div>';
    vi.stubGlobal('chrome', {runtime: {getURL: (/** @type {string} */ path) => `${origin}${path}`}});
    const controller = new PopupPreviewController(/** @type {import('../ext/js/pages/settings/settings-controller.js').SettingsController} */ (/** @type {unknown} */ ({})));
    const frame = /** @type {HTMLIFrameElement} */ (window.document.querySelector('#popup-preview-frame'));
    const frameWindow = /** @type {Window} */ (frame.contentWindow);
    // eslint-disable-next-line no-underscore-dangle
    const invoke = controller._invoke.bind(controller);
    // eslint-disable-next-line no-underscore-dangle
    const onFrameMessage = controller._onFrameMessage.bind(controller);
    return {invoke, onFrameMessage, frameWindow};
}

describe('Popup preview RPC', () => {
    domTest('ignores replies from another frame and resolves the owning reply', async ({window}) => {
        const {invoke, onFrameMessage, frameWindow} = createController(window);
        vi.spyOn(frameWindow, 'postMessage').mockImplementation(() => {});
        vi.useFakeTimers();
        const promise = invoke('setCustomCss', {css: 'body {color: red}'});
        const otherFrame = window.document.createElement('iframe');
        window.document.body.appendChild(otherFrame);

        onFrameMessage(new window.MessageEvent('message', {
            origin,
            source: otherFrame.contentWindow,
            data: {id: 'popup-preview-1', error: 'unexpected reply'},
        }));
        expect(vi.getTimerCount()).toBe(1);
        onFrameMessage(new window.MessageEvent('message', {
            origin,
            source: frameWindow,
            data: {id: 'popup-preview-1'},
        }));

        await expect(promise).resolves.toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
    });

    domTest('rejects an error reply and releases its timeout', async ({window}) => {
        const {invoke, onFrameMessage, frameWindow} = createController(window);
        vi.spyOn(frameWindow, 'postMessage').mockImplementation(() => {});
        vi.useFakeTimers();
        const promise = invoke('updateSearch', {});

        onFrameMessage(new window.MessageEvent('message', {
            origin,
            source: frameWindow,
            data: {id: 'popup-preview-1', error: 'dictionary unavailable'},
        }));

        await expect(promise).rejects.toThrow('dictionary unavailable');
        expect(vi.getTimerCount()).toBe(0);
    });

    domTest('settles a timed out request instead of leaving the caller pending', async ({window}) => {
        const {invoke, frameWindow} = createController(window);
        vi.spyOn(frameWindow, 'postMessage').mockImplementation(() => {});
        vi.useFakeTimers();
        const promise = invoke('updateOptionsContext', {optionsContext: {current: true}});
        const rejection = expect(promise).rejects.toThrow('Popup preview RPC timed out: updateOptionsContext');

        await vi.advanceTimersByTimeAsync(2000);

        await rejection;
        expect(vi.getTimerCount()).toBe(0);
    });

    domTest('clears a failed postMessage request immediately', async ({window}) => {
        const {invoke, frameWindow} = createController(window);
        vi.spyOn(frameWindow, 'postMessage').mockImplementation(() => { throw new Error('frame removed'); });
        vi.useFakeTimers();

        await expect(invoke('updateSearch', {})).rejects.toThrow('frame removed');
        expect(vi.getTimerCount()).toBe(0);
    });
});
