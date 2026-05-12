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

import {EventListenerCollection} from '../core/event-listener-collection.js';
import {base64ToArrayBuffer} from '../data/array-buffer-util.js';

/**
 * The content manager which is used when generating HTML display content.
 */
export class DisplayContentManager {
    /**
     * Creates a new instance of the class.
     * @param {import('./display.js').Display} display The display instance that owns this object.
     */
    constructor(display) {
        /** @type {import('./display.js').Display} */
        this._display = display;
        /** @type {import('core').TokenObject} */
        this._token = {};
        /** @type {EventListenerCollection} */
        this._eventListeners = new EventListenerCollection();
        /** @type {import('display-content-manager').LoadMediaRequest[]} */
        this._loadMediaRequests = [];
        this._isSafari = chrome.runtime.getURL('/').startsWith('safari-web-extension://');
        this._loadMediaData = [];
        this._mediaCache = new Map();
    }

    /** @type {import('display-content-manager').LoadMediaRequest[]} */
    get loadMediaRequests() {
        return this._loadMediaRequests;
    }

    /**
     * @param {string} path
     * @param {string} dictionary
     * @param {OffscreenCanvas|((url: string) => void)} canvasOrOnLoad
     * @param {?Function} onUnload
     */
    loadMedia(path, dictionary, canvasOrOnLoad, onUnload = null) {
        if (this._supportsOffscreenCanvasMediaLoading()) {
            this._loadMediaRequests.push({
                path,
                dictionary,
                canvas: canvasOrOnLoad,
            });
            return;
        }

        if (typeof canvasOrOnLoad !== 'function') { return; }

        void this._loadMediaDirect(path, dictionary, canvasOrOnLoad, onUnload);
    }
    
    supportsOffscreenCanvasMediaLoading() {
        return this._supportsOffscreenCanvasMediaLoading();
    }

    _supportsOffscreenCanvasMediaLoading() {
        return !this._isSafari &&
            typeof OffscreenCanvas !== 'undefined' &&
            typeof createImageBitmap !== 'undefined' &&
            typeof HTMLCanvasElement.prototype.transferControlToOffscreen === 'function';
    }
    
    async _loadMediaDirect(path, dictionary, onLoad, onUnload) {
        const token = this._token;
        const data = {onUnload, loaded: false};
        this._loadMediaData.push(data);

        const media = await this._getMediaDirect(path, dictionary);
        if (token !== this._token || media.url === null) { return; }

        onLoad(media.url);
        data.loaded = true;
    }

    async _getMediaDirect(path, dictionary) {
        let dictionaryCache = this._mediaCache.get(dictionary);
        if (typeof dictionaryCache === 'undefined') {
            dictionaryCache = new Map();
            this._mediaCache.set(dictionary, dictionaryCache);
        }

        let cachedData = dictionaryCache.get(path);
        if (typeof cachedData === 'undefined') {
            cachedData = {promise: null, data: null, url: null};
            dictionaryCache.set(path, cachedData);
            cachedData.promise = this._getMediaDataDirect(path, dictionary, cachedData);
        }

        return await cachedData.promise;
    }

    async _getMediaDataDirect(path, dictionary, cachedData) {
        const [data] = await this._display.application.api.getMedia([{path, dictionary}]);

        if (data === null) {
            return cachedData;
        }

        const buffer = base64ToArrayBuffer(data.content);
        const blob = new Blob([buffer], {type: data.mediaType});
        cachedData.data = data;
        cachedData.url = URL.createObjectURL(blob);

        return cachedData;
    }

    /**
     * Unloads all media that has been loaded.
     */
    unloadAll() {
        this._token = {};

        this._eventListeners.removeAllEventListeners();

        this._loadMediaRequests = [];
        
        for (const {onUnload, loaded} of this._loadMediaData) {
            if (loaded && typeof onUnload === 'function') {
                onUnload();
            }
        }
        this._loadMediaData = [];
    }

    /**
     * Sets up attributes and events for a link element.
     * @param {HTMLAnchorElement} element The link element.
     * @param {string} href The URL.
     * @param {boolean} internal Whether or not the URL is an internal or external link.
     */
    prepareLink(element, href, internal) {
        element.href = href;
        if (!internal) {
            element.target = '_blank';
            element.rel = 'noreferrer noopener';
        }
        this._eventListeners.addEventListener(element, 'click', this._onLinkClick.bind(this));
    }

    /**
     * Execute media requests
     */
    async executeMediaRequests() {
        await this._display.application.api.drawMedia(
            this._loadMediaRequests,
            this._loadMediaRequests.map(({canvas}) => canvas),
        );
        this._loadMediaRequests = [];
    }

    /**
     * @param {string} path
     * @param {string} dictionary
     * @param {Window} window
     */
    async openMediaInTab(path, dictionary, window) {
        const data = await this._display.application.api.getMedia([{path, dictionary}]);
        const buffer = base64ToArrayBuffer(data[0].content);
        const blob = new Blob([buffer], {type: data[0].mediaType});
        const blobUrl = URL.createObjectURL(blob);
        window.open(blobUrl, '_blank')?.focus();
    }

    /**
     * @param {MouseEvent} e
     */
    _onLinkClick(e) {
        const {href} = /** @type {HTMLAnchorElement} */ (e.currentTarget);
        if (typeof href !== 'string') { return; }

        const baseUrl = new URL(location.href);
        const url = new URL(href, baseUrl);
        const internal = (url.protocol === baseUrl.protocol && url.host === baseUrl.host);
        if (!internal) { return; }

        e.preventDefault();

        /** @type {import('display').HistoryParams} */
        const params = {};
        for (const [key, value] of url.searchParams.entries()) {
            params[key] = value;
        }
        this._display.setContent({
            historyMode: 'new',
            focus: false,
            params,
            state: null,
            content: null,
        });
    }
}
