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
import {isSafariPopupIframeContext} from '../comm/safari-cross-frame-rpc.js';
import {toError} from '../core/to-error.js';
import {deferPromise} from '../core/utilities.js';
import {DocumentFocusController} from '../dom/document-focus-controller.js';
import {HotkeyHandler} from '../input/hotkey-handler.js';
import {DisplayAnki} from './display-anki.js';
import {DisplayAudio} from './display-audio.js';
import {DisplayProfileSelection} from './display-profile-selection.js';
import {DisplayResizer} from './display-resizer.js';
import {Display} from './display.js';

/** @type {import('core').DeferredPromiseDetails<Display>} */
const safariPopupDisplayReady = deferPromise();

/**
 * @typedef {{
 *   yomitanSafariPopupRpc: true,
 *   type: 'invoke',
 *   clientId: string,
 *   id: string,
 * } & (
 *   {apiAction: 'displayPopupMessage1', params: {data: import('display').DirectApiMessageAny}} |
 *   {apiAction: 'displayPopupMessage2', params: import('display').DirectApiMessageAny}
 * )} SafariPopupInvokeMessage
 */

/** @returns {void} */
function setupSafariPopupRpcEarly() {
    if (!isSafariPopupIframeContext()) { return; }

    /** @param {MessageEvent<SafariPopupInvokeMessage>} event */
    const onMessage = async (event) => {
        const message = event.data;

        if (message?.yomitanSafariPopupRpc !== true || message?.type !== 'invoke') {
            return;
        }
        const source = window.parent;
        if (event.source !== source) { return; }

        const targetOrigin = (
            typeof event.origin === 'string' &&
            event.origin.length > 0 &&
            event.origin !== 'null'
        ) ?
event.origin :
'*';

        let result;
        let error = null;
        const {apiAction} = message;
        try {
            const display = await safariPopupDisplayReady.promise;

            if (message.apiAction === 'displayPopupMessage1') {
                const messageInner = message.params.data;
                result = await display.invokeDirectMessage(messageInner);
            } else if (message.apiAction === 'displayPopupMessage2') {
                result = await display.invokeDirectMessage(message.params);
            } else {
                throw new Error(`Unsupported Safari popup RPC action: ${apiAction}`);
            }
        } catch (e) {
            error = toError(e).message;
        }

        try {
            source.postMessage({
                yomitanSafariPopupRpc: true,
                type: 'result',
                clientId: message.clientId,
                id: message.id,
                result,
                error,
            }, targetOrigin);
        } catch (e) {
            // Navigation can remove the waiting frame before a reply is sent.
            if (e instanceof DOMException && (e.name === 'SecurityError' || e.name === 'InvalidStateError')) { return; }
            throw e;
        }
    };
    window.addEventListener('message', onMessage);

    window.parent.postMessage({
        yomitanSafariPopupRpc: true,
        type: 'ready',
    }, '*');
}

setupSafariPopupRpcEarly();

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
