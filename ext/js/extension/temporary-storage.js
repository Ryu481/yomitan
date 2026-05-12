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

import {isObjectNotArray} from '../core/object-utilities.js';

/**
 * Safari does not consistently expose `chrome.storage.session`, so use local storage as a
 * temporary fallback for flags that only coordinate extension pages during the current setup flow.
 * @returns {chrome.storage.StorageArea}
 */
export function getTemporaryStorage() {
    const {storage} = chrome;
    if (isObjectNotArray(storage) && isObjectNotArray(storage.session)) {
        return storage.session;
    }
    return chrome.storage.local;
}
