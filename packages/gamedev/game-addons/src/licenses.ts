/**
 * License texts the installer writes into the project's notices when an add-on's archive carries no license file: the
 * MIT License, whose permission notice must accompany every copy, with the entry's copyright line.
 * @module @deepseek-ai/dsh-game-addons/src/licenses
 */

const MIT_TERMS = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

/**
 * The standard text of a license that requires its notice, for an add-on whose archive has no license file.
 * @param spdx - the entry's SPDX license identifier.
 * @param copyright - the entry's copyright line.
 * @returns the license text, or undefined for a license without a standard text here.
 */
export function standardLicenseText(spdx: string, copyright: string): string | undefined {
  return spdx === 'MIT' ? `MIT License\n\n${copyright}\n\n${MIT_TERMS}\n` : undefined
}
