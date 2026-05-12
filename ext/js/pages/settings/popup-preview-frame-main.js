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

import {PopupFactory} from '../../app/popup-factory.js';
import {Application} from '../../application.js';
import {HotkeyHandler} from '../../input/hotkey-handler.js';
import {PopupPreviewFrame} from './popup-preview-frame.js';

function prepareSafariCrossFrameRpcResponder(application, popupFactory) {
    window.addEventListener('message', async (event) => {
        const data = event.data;
        if (data?.yomitanSafariCrossFrameRpc !== true || data?.type !== 'invoke') { return; }
        
        let result;
        let error = null;
        
        try {
            result = await invokeSafariCrossFrameAction(application, popupFactory, data.action, data.params);
        } catch (e) {
            error = `${e?.message ?? e}`;
        }
        
        if (event.source === null) { return; }
        
        event.source.postMessage({
            yomitanSafariCrossFrameRpc: true,
            type: 'result',
            clientId: data.clientId,
            id: data.id,
            result,
            error,
        }, event.origin);
    });
}

async function invokeSafariCrossFrameAction(application, popupFactory, action, params) {
    switch (action) {
        case 'popupFactoryGetOrCreatePopup':
            return await popupFactory._onApiGetOrCreatePopup(params);
        case 'popupFactorySetOptionsContext':
            return await popupFactory._onApiSetOptionsContext(params);
        case 'popupFactoryHide':
            return await popupFactory._onApiHide(params);
        case 'popupFactoryIsVisible':
            return await popupFactory._onApiIsVisibleAsync(params);
        case 'popupFactorySetVisibleOverride':
            return await popupFactory._onApiSetVisibleOverride(params);
        case 'popupFactoryClearVisibleOverride':
            return await popupFactory._onApiClearVisibleOverride(params);
        case 'popupFactoryContainsPoint':
            return await popupFactory._onApiContainsPoint(params);
        case 'popupFactoryShowContent':
            return await popupFactory._onApiShowContent(params);
        case 'popupFactorySetCustomCss':
            return await popupFactory._onApiSetCustomCss(params);
        case 'popupFactoryClearAutoPlayTimer':
            return await popupFactory._onApiClearAutoPlayTimer(params);
        case 'popupFactorySetContentScale':
            return await popupFactory._onApiSetContentScale(params);
        case 'popupFactoryUpdateTheme':
            return await popupFactory._onApiUpdateTheme(params);
        case 'popupFactorySetCustomOuterCss':
            return await popupFactory._onApiSetCustomOuterCss(params);
        case 'popupFactoryGetFrameSize':
            return await popupFactory._onApiGetFrameSize(params);
        case 'popupFactorySetFrameSize':
            return await popupFactory._onApiSetFrameSize(params);
        case 'popupFactoryIsPointerOver':
            return await popupFactory._onApiIsPointerOver(params);
        default:
            return await application.crossFrame.invokeLocal(action, params);
    }
}

await Application.main(true, async (application) => {
    const hotkeyHandler = new HotkeyHandler();
    hotkeyHandler.prepare(application.crossFrame);

    const popupFactory = new PopupFactory(application);
    popupFactory.prepare();

    prepareSafariCrossFrameRpcResponder(application, popupFactory);

    const preview = new PopupPreviewFrame(application, popupFactory, hotkeyHandler);
    await preview.prepare();

    document.documentElement.dataset.loaded = 'true';
});
