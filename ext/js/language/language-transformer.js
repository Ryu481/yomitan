/*
 * Copyright (C) 2024-2026  Yomitan Authors
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

import {log} from '../core/log.js';

export class LanguageTransformer {
    constructor() {
        /** @type {number} */
        this._nextFlagIndex = 0;
        /** @type {import('language-transformer-internal').Transform[]} */
        this._transforms = [];
        /** @type {Map<string, number>} */
        this._conditionTypeToConditionFlagsMap = new Map();
        /** @type {Map<string, number>} */
        this._partOfSpeechToConditionFlagsMap = new Map();
    }

    /** */
    clear() {
        this._nextFlagIndex = 0;
        this._transforms = [];
        this._conditionTypeToConditionFlagsMap.clear();
        this._partOfSpeechToConditionFlagsMap.clear();
    }

    /**
     * @param {import('language-transformer').LanguageTransformDescriptor} descriptor
     * @throws {Error}
     */
    addDescriptor(descriptor) {
        const {conditions, transforms} = descriptor;
        const conditionEntries = Object.entries(conditions);
        const {conditionFlagsMap, nextFlagIndex} = this._getConditionFlagsMap(conditionEntries, this._nextFlagIndex);

        /** @type {import('language-transformer-internal').Transform[]} */
        const transforms2 = [];

        for (const [transformId, transform] of Object.entries(transforms)) {
            const {name, description, readingTransform, rules} = transform;
            /** @type {import('language-transformer-internal').Rule[]} */
            const rules2 = [];
            for (let j = 0, jj = rules.length; j < jj; ++j) {
                const {type, isInflected, deinflect, inflect, conditionsIn, conditionsOut} = rules[j];
                const conditionFlagsIn = this._getConditionFlagsStrict(conditionFlagsMap, conditionsIn);
                if (conditionFlagsIn === null) { throw new Error(`Invalid conditionsIn for transform ${transformId}.rules[${j}]`); }
                const conditionFlagsOut = this._getConditionFlagsStrict(conditionFlagsMap, conditionsOut);
                if (conditionFlagsOut === null) { throw new Error(`Invalid conditionsOut for transform ${transformId}.rules[${j}]`); }
                rules2.push({
                    type,
                    isInflected,
                    deinflect,
                    inflect,
                    conditionsIn: conditionFlagsIn,
                    conditionsOut: conditionFlagsOut,
                });
            }
            const isInflectedTests = rules.map((rule) => rule.isInflected);
            const heuristic = new RegExp(isInflectedTests.map((regExp) => regExp.source).join('|'));
            transforms2.push({id: transformId, name, description, readingTransform, rules: rules2, heuristic});
        }

        this._nextFlagIndex = nextFlagIndex;
        for (const transform of transforms2) {
            this._transforms.push(transform);
        }

        for (const [type, {isDictionaryForm}] of conditionEntries) {
            const flags = conditionFlagsMap.get(type);
            if (typeof flags === 'undefined') { continue; } // This case should never happen
            this._conditionTypeToConditionFlagsMap.set(type, flags);
            if (isDictionaryForm) {
                this._partOfSpeechToConditionFlagsMap.set(type, flags);
            }
        }
    }

    /**
     * @param {string[]} partsOfSpeech
     * @returns {number}
     */
    getConditionFlagsFromPartsOfSpeech(partsOfSpeech) {
        return this._getConditionFlags(this._partOfSpeechToConditionFlagsMap, partsOfSpeech);
    }

    /**
     * @param {string[]} conditionTypes
     * @returns {number}
     */
    getConditionFlagsFromConditionTypes(conditionTypes) {
        return this._getConditionFlags(this._conditionTypeToConditionFlagsMap, conditionTypes);
    }

    /**
     * @param {string} conditionType
     * @returns {number}
     */
    getConditionFlagsFromConditionType(conditionType) {
        return this._getConditionFlags(this._conditionTypeToConditionFlagsMap, [conditionType]);
    }

    /**
     * @param {string} sourceText
     * @returns {import('language-transformer-internal').TransformedText[]}
     */
    transform(sourceText) {
        const results = [LanguageTransformer.createTransformedText(sourceText, 0, [])];
        for (let i = 0; i < results.length; ++i) {
            const {text, conditions, trace} = results[i];
            for (const transform of this._transforms) {
                if (!transform.heuristic.test(text)) { continue; }

                const {id, rules} = transform;
                for (let j = 0, jj = rules.length; j < jj; ++j) {
                    const rule = rules[j];
                    if (!LanguageTransformer.conditionsMatch(conditions, rule.conditionsIn)) { continue; }
                    const {isInflected, deinflect} = rule;
                    if (!isInflected.test(text)) { continue; }

                    const isCycle = trace.some((frame) => frame.transform === id && frame.ruleIndex === j && frame.text === text);
                    if (isCycle) {
                        log.warn(new Error(`Cycle detected in transform[${id}] rule[${j}] for text: ${text}\nTrace: ${JSON.stringify(trace)}`));
                        continue;
                    }

                    results.push(LanguageTransformer.createTransformedText(
                        deinflect(text),
                        rule.conditionsOut,
                        this._extendTrace(trace, {transform: id, ruleIndex: j, text}),
                    ));
                }
            }
        }
        return results;
    }

    /**
     * Reconstructs an inflected spelling from a dictionary-form spelling and a
     * deinflection trace. A configured reading transform or an unambiguous
     * parallel rule with the same conditions is used when necessary. This is
     * useful for readings whose inflection differs from the written form.
     * @param {string} text
     * @param {import('language-transformer-internal').Trace} trace
     * @returns {import('language-transformer-internal').InflectedText|null}
     */
    getInflectedText(text, trace) {
        let usedAlternativeRule = false;
        for (const {transform: transformId, ruleIndex} of trace) {
            const transform = this._transforms.find(({id}) => id === transformId);
            if (typeof transform === 'undefined') { return null; }

            const tracedRule = transform.rules[ruleIndex];
            if (typeof tracedRule?.inflect !== 'function') { return null; }

            if (typeof transform.readingTransform === 'string') {
                const readingTransform = this._transforms.find(({id}) => id === transform.readingTransform);
                if (typeof readingTransform === 'undefined') { return null; }
                const candidates = this._getInflectionCandidates(text, tracedRule, readingTransform.rules);
                if (candidates.size > 1) { return null; }
                if (candidates.size === 1) {
                    [text] = candidates;
                    usedAlternativeRule = true;
                    continue;
                }
            }

            let inflectedText = tracedRule.inflect(text);
            if (inflectedText === null) {
                const candidates = this._getInflectionCandidates(text, tracedRule, transform.rules);
                if (candidates.size !== 1) { return null; }
                [inflectedText] = candidates;
                usedAlternativeRule = true;
            }
            if (inflectedText === null) { return null; }
            text = inflectedText;
        }
        return {text, usedAlternativeRule};
    }

    /**
     * @param {string} text
     * @param {import('language-transformer-internal').Rule} tracedRule
     * @param {import('language-transformer-internal').Rule[]} rules
     * @returns {Set<string>}
     */
    _getInflectionCandidates(text, tracedRule, rules) {
        /** @type {Set<string>} */
        const candidates = new Set();
        for (const rule of rules) {
            if (
                rule.type !== tracedRule.type ||
                rule.conditionsIn !== tracedRule.conditionsIn ||
                rule.conditionsOut !== tracedRule.conditionsOut ||
                typeof rule.inflect !== 'function'
            ) {
                continue;
            }
            const candidate = rule.inflect(text);
            if (candidate !== null) { candidates.add(candidate); }
        }
        return candidates;
    }

    /**
     * @param {string[]} inflectionRules
     * @returns {import('dictionary').InflectionRuleChain}
     */
    getUserFacingInflectionRules(inflectionRules) {
        return inflectionRules.map((rule) => {
            const fullRule = this._transforms.find((transform) => transform.id === rule);
            if (typeof fullRule === 'undefined') { return {name: rule}; }
            const {name, description} = fullRule;
            return description ? {name, description} : {name};
        });
    }

    /**
     * @param {string} text
     * @param {number} conditions
     * @param {import('language-transformer-internal').Trace} trace
     * @returns {import('language-transformer-internal').TransformedText}
     */
    static createTransformedText(text, conditions, trace) {
        return {text, conditions, trace};
    }

    /**
     * If `currentConditions` is `0`, then `nextConditions` is ignored and `true` is returned.
     * Otherwise, there must be at least one shared condition between `currentConditions` and `nextConditions`.
     * @param {number} currentConditions
     * @param {number} nextConditions
     * @returns {boolean}
     */
    static conditionsMatch(currentConditions, nextConditions) {
        return currentConditions === 0 || (currentConditions & nextConditions) !== 0;
    }

    /**
     * @param {import('language-transformer').ConditionMapEntries} conditions
     * @param {number} nextFlagIndex
     * @returns {{conditionFlagsMap: Map<string, number>, nextFlagIndex: number}}
     * @throws {Error}
     */
    _getConditionFlagsMap(conditions, nextFlagIndex) {
        /** @type {Map<string, number>} */
        const conditionFlagsMap = new Map();
        /** @type {import('language-transformer').ConditionMapEntries} */
        let targets = conditions;
        while (targets.length > 0) {
            const nextTargets = [];
            for (const target of targets) {
                const [type, condition] = target;
                const {subConditions} = condition;
                let flags = 0;
                if (typeof subConditions === 'undefined') {
                    if (nextFlagIndex >= 32) {
                        // Flags greater than or equal to 32 don't work because JavaScript only supports up to 32-bit integer operations
                        throw new Error('Maximum number of conditions was exceeded');
                    }
                    flags = 1 << nextFlagIndex;
                    ++nextFlagIndex;
                } else {
                    const multiFlags = this._getConditionFlagsStrict(conditionFlagsMap, subConditions);
                    if (multiFlags === null) {
                        nextTargets.push(target);
                        continue;
                    } else {
                        flags = multiFlags;
                    }
                }
                conditionFlagsMap.set(type, flags);
            }
            if (nextTargets.length === targets.length) {
                // Cycle in subRule declaration
                throw new Error('Maximum number of conditions was exceeded');
            }
            targets = nextTargets;
        }
        return {conditionFlagsMap, nextFlagIndex};
    }

    /**
     * @param {Map<string, number>} conditionFlagsMap
     * @param {string[]} conditionTypes
     * @returns {?number}
     */
    _getConditionFlagsStrict(conditionFlagsMap, conditionTypes) {
        let flags = 0;
        for (const conditionType of conditionTypes) {
            const flags2 = conditionFlagsMap.get(conditionType);
            if (typeof flags2 === 'undefined') {
                return null;
            }
            flags |= flags2;
        }
        return flags;
    }

    /**
     * @param {Map<string, number>} conditionFlagsMap
     * @param {string[]} conditionTypes
     * @returns {number}
     */
    _getConditionFlags(conditionFlagsMap, conditionTypes) {
        let flags = 0;
        for (const conditionType of conditionTypes) {
            let flags2 = conditionFlagsMap.get(conditionType);
            if (typeof flags2 === 'undefined') {
                flags2 = 0;
            }
            flags |= flags2;
        }
        return flags;
    }

    /**
     * @param {import('language-transformer-internal').Trace} trace
     * @param {import('language-transformer-internal').TraceFrame} newFrame
     * @returns {import('language-transformer-internal').Trace}
     */
    _extendTrace(trace, newFrame) {
        const newTrace = [newFrame];
        for (const {transform, ruleIndex, text} of trace) {
            newTrace.push({transform, ruleIndex, text});
        }
        return newTrace;
    }
}
