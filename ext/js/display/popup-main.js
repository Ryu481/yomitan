/*
 * Copyright (C) 2023-2026  Yomitan Authors
 * Copyright (C) 2020-2022  Yomichan Authors
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

import {Application} from '../application.js';
import {DocumentFocusController} from '../dom/document-focus-controller.js';
import {HotkeyHandler} from '../input/hotkey-handler.js';
import {DisplayAnki} from './display-anki.js';
import {DisplayAudio} from './display-audio.js';
import {DisplayProfileSelection} from './display-profile-selection.js';
import {DisplayResizer} from './display-resizer.js';
import {Display} from './display.js';

const safariPopupDisplayReady = (() => {
    let resolve;
    const promise = new Promise((resolve2) => {
        resolve = resolve2;
    });
    return {promise, resolve};
})();

function isSafariPopupIframeContext() {
    try {
        return window.parent !== window && location.pathname.endsWith('/popup.html');
    } catch {
        return false;
    }
}

function setupSafariPopupRpcEarly() {
    if (!isSafariPopupIframeContext()) { return; }

    console.log('[SafariPopupIframe] RPC early enabled', {
        href: location.href,
        origin: location.origin
    });

    window.addEventListener('message', async (event) => {
        const message = event.data;

        if (message?.yomitanSafariPopupRpc !== true || message?.type !== 'invoke') {
            return;
        }
        if (event.source !== window.parent) {
            return;
        }

        const targetOrigin = (
            typeof event.origin === 'string' &&
            event.origin.length > 0 &&
            event.origin !== 'null'
        ) ? event.origin : '*';

        try {

            const display = await safariPopupDisplayReady.promise;

            let result;

            if (message.apiAction === 'displayPopupMessage1') {
                const messageInner = message.params.data;
                result = await display._onDisplayPopupMessage2(messageInner);
            } else if (message.apiAction === 'displayPopupMessage2') {
                result = await display._onDisplayPopupMessage2(message.params);
            } else {
                throw new Error(`Unsupported Safari popup RPC action: ${message.apiAction}`);
            }

            event.source.postMessage({
                yomitanSafariPopupRpc: true,
                type: 'result',
                clientId: message.clientId,
                id: message.id,
                result
            }, targetOrigin);
        } catch (e) {
            console.error('[SafariPopupIframe] invoke failed', e);

            event.source.postMessage({
                yomitanSafariPopupRpc: true,
                type: 'result',
                clientId: message.clientId,
                id: message.id,
                error: `${e?.message ?? e}`
            }, targetOrigin);
        }
    });

    window.parent.postMessage({
        yomitanSafariPopupRpc: true,
        type: 'ready'
    }, '*');

    console.log('[SafariPopupIframe] early ready sent');
}

setupSafariPopupRpcEarly();

console.log('[SafariPopupIframe] script loaded', {
    href: location.href,
    origin: location.origin,
    parentExists: window.parent !== window,
    topIsSelf: window.top === window
});

window.addEventListener('error', (event) => {
    console.error('[SafariPopupIframe] window error', {
        message: event.message,
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        error: event.error
    });
});

window.addEventListener('unhandledrejection', (event) => {
    console.error('[SafariPopupIframe] unhandled rejection', event.reason);
});

console.log('[SafariPopupIframe] before Application.main');

await Application.main(true, async (application) => {
    const documentFocusController = new DocumentFocusController();
    documentFocusController.prepare();

    const hotkeyHandler = new HotkeyHandler();
    hotkeyHandler.prepare(application.crossFrame);

    const display = new Display(application, 'popup', documentFocusController, hotkeyHandler);
    await display.prepare();


    safariPopupDisplayReady.resolve(display);

    const displayAudio = new DisplayAudio(display);
    displayAudio.prepare();

    const displayAnki = new DisplayAnki(display, displayAudio);
    displayAnki.prepare();

    const displayProfileSelection = new DisplayProfileSelection(display);
    void displayProfileSelection.prepare();

    const displayResizer = new DisplayResizer(display);
    displayResizer.prepare();

    display.initializeState();

    document.documentElement.dataset.loaded = 'true';
});
