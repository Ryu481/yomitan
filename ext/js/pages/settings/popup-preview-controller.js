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

import {log} from '../../core/log.js';
import {toError} from '../../core/to-error.js';
import {querySelectorNotNull} from '../../dom/query-selector.js';

export class PopupPreviewController {
    /**
     * @param {import('./settings-controller.js').SettingsController} settingsController
     */
    constructor(settingsController) {
        /** @type {import('./settings-controller.js').SettingsController} */
        this._settingsController = settingsController;
        /** @type {string} */
        this._targetOrigin = chrome.runtime.getURL('/').replace(/\/$/, '');
        /** @type {HTMLIFrameElement} */
        this._frame = querySelectorNotNull(document, '#popup-preview-frame');
        /** @type {HTMLTextAreaElement} */
        this._customCss = querySelectorNotNull(document, '#custom-popup-css');
        /** @type {HTMLTextAreaElement} */
        this._customOuterCss = querySelectorNotNull(document, '#custom-popup-outer-css');
        /** @type {HTMLElement} */
        this._previewFrameContainer = querySelectorNotNull(document, '.preview-frame-container');
        /** @type {number} */
        this._invokeId = 0;
        /** @type {Map<string, {resolve: (value: void) => void, reject: (reason: Error) => void, timeout: import('core').Timeout}>} */
        this._pendingInvokes = new Map();
    }

    /** */
    prepare() {
        if (new URLSearchParams(location.search).get('popup-preview') === 'false') { return; }

        this._customCss.addEventListener('input', this._onCustomCssChange.bind(this), false);
        this._customCss.addEventListener('settingChanged', this._onCustomCssChange.bind(this), false);
        this._customOuterCss.addEventListener('input', this._onCustomOuterCssChange.bind(this), false);
        this._customOuterCss.addEventListener('settingChanged', this._onCustomOuterCssChange.bind(this), false);
        this._frame.addEventListener('load', this._onFrameLoad.bind(this), false);
        const onOptionsContextChange = () => { void this._onOptionsContextChange().catch((error) => log.error(error)); };
        this._settingsController.on('optionsContextChanged', onOptionsContextChange);
        this._settingsController.on('optionsChanged', this._onOptionsChanged.bind(this));
        this._settingsController.on('dictionaryEnabled', onOptionsContextChange);
        const languageSelect = querySelectorNotNull(document, '#language-select');
        languageSelect.addEventListener(
            /** @type {string} */ ('settingChanged'),
            /** @type {EventListener} */ (this._onLanguageSelectChanged.bind(this)),
            false,
        );


        this._frame.src = chrome.runtime.getURL('/popup-preview.html');
        window.addEventListener('message', this._onFrameMessage.bind(this), false);
    }

    // Private

    /**
     * @param {MessageEvent<{id: string, result?: void, error?: string}>} event
     */
    _onFrameMessage(event) {
        if (event.origin.toLowerCase() !== this._targetOrigin.toLowerCase()) { return; }
        if (event.source !== this._frame.contentWindow) { return; }

        const {data} = event;
        if (typeof data !== 'object' || data === null) { return; }

        const {id, result, error} = data;
        if (typeof id !== 'string') { return; }

        const pending = this._pendingInvokes.get(id);
        if (typeof pending === 'undefined') { return; }

        this._pendingInvokes.delete(id);
        clearTimeout(pending.timeout);

        if (typeof error === 'string') {
            pending.reject(new Error(error));
        } else {
            pending.resolve(result);
        }
    }

    /** */
    _onFrameLoad() {
        void this._onOptionsContextChange().catch((error) => log.error(error));
        this._onCustomCssChange();
        this._onCustomOuterCssChange();
    }

    /** */
    _onCustomCssChange() {
        const css = /** @type {HTMLTextAreaElement} */ (this._customCss).value;
        void this._invoke('setCustomCss', {css}).catch((error) => log.error(error));
    }

    /** */
    _onCustomOuterCssChange() {
        const css = /** @type {HTMLTextAreaElement} */ (this._customOuterCss).value;
        void this._invoke('setCustomOuterCss', {css}).catch((error) => log.error(error));
    }

    /** */
    async _onOptionsContextChange() {
        const optionsContext = this._settingsController.getOptionsContext();
        await this._invoke('updateOptionsContext', {optionsContext});
    }

    /** */
    async _onDictionaryEnabled() {
        await this._onOptionsContextChange();
        await this._invoke('updateSearch', {});
    }

    /**
     * @param {import('settings-controller').EventArgument<'optionsChanged'>} details
     */
    _onOptionsChanged({options}) {
        void this._invoke('setLanguageExampleText', {language: options.general.language}).catch((error) => log.error(error));
    }

    /**
     * @param {import('dom-data-binder').SettingChangedEvent} settingChangedEvent
     */
    _onLanguageSelectChanged(settingChangedEvent) {
        const {value} = settingChangedEvent.detail;
        if (typeof value !== 'string') { return; }
        void this._invoke('setLanguageExampleText', {language: value}).catch((error) => log.error(error));
    }

    /**
     * @template {import('popup-preview-frame').ApiNames} TName
     * @param {TName} action
     * @param {import('popup-preview-frame').ApiParams<TName>} params
     * @returns {Promise<void>}
     */
    _invoke(action, params) {
        if (this._frame === null || this._frame.contentWindow === null) {
            return Promise.resolve(void 0);
        }

        const id = `popup-preview-${++this._invokeId}`;
        const contentWindow = this._frame.contentWindow;

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this._pendingInvokes.delete(id);
                reject(new Error(`Popup preview RPC timed out: ${action}`));
            }, 2000);

            this._pendingInvokes.set(id, {resolve, reject, timeout});

            try {
                contentWindow.postMessage(
                    {action, params, id},
                    this._targetOrigin,
                );
            } catch (e) {
                this._pendingInvokes.delete(id);
                clearTimeout(timeout);
                reject(toError(e));
            }
        });
    }
}

/**
 * @param {string | undefined} url
 * @returns {boolean}
 */
export function checkPopupPreviewURL(url) {
    return !!(url && url.includes('popup-preview.html') && !['http:', 'https:', 'ws:', 'wss:', 'ftp:', 'data:', 'file:'].includes(new URL(url).protocol));
}
