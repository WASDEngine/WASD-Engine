---
description: "Art references for the agent: reference_search finds reference images, animations, and video posters on the web for art the agent is about to make and numbers them on one contact sheet, reference_save saves the chosen ones with their sources into the game project's references folder, which Godot leaves out of the game, and a system prompt section has the agent gather references before it makes any art and ask the user which direction they want when the references disagree."
kind: "package-reference"
---

# @deepseek-ai/dsh-art-references

English | [中文](README.zh.md)

## Summary

The art references plugin gives the agent reference material before it makes a game's art. When the user asks for a sprite, texture, model, or animation, the agent searches the web for references on its own, shows them on one numbered contact sheet, and asks which direction the user wants when they differ. It saves the references it uses, with their sources, into the project's `references/` folder and works from them: as images for `image_generate`, as a picture to compare Blender and GIMP work with, and, for an animated GIF, as a frames sheet. Connected agents get the same tools.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### Default composition

The WASDEngine overlay [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) inserts the row `art-references` into every Web and Desktop profile, with its cache folder in the WASD Engine home:

```yaml
- id: art-references
  name: '@deepseek-ai/dsh-art-references'
  config:
    dataRoot: !!js dshHomePath('art-references')
```

The plugin needs the `tools`, `web`, and `workingDirectory` services; with the `systemPrompt` service it adds the `art-references` section, and with the `gameMcp` service of [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.md) it offers its tools to connected agents. Activation makes no request; it deletes cached files older than `cacheDays`. A relative `dataRoot` fails the plugin load. The Game tools tabs do not list the row: like the asset and audio tools, it is part of how the agent works rather than an application it drives.

| Field | Default | Meaning |
|---|---|---|
| `dataRoot` | required | Absolute cache folder: downloaded images in `images/`, contact sheets in `sheets/` |
| `userAgent` | `Mozilla/5.0 (compatible; WASDEngine-References/1.0; +https://wasdengine.com)` | `User-Agent` of every page and image request |
| `cacheDays` | `30` | Days a cached download or contact sheet is kept and reused |
| `searchTimeoutMs` | `150000` | Time limit of one `reference_search` call |
| `saveTimeoutMs` | `120000` | Time limit of one `reference_save` call |
| `maxQueries` | `4` | Most queries one search takes |
| `maxPages` | `4` | Most pages one search reads by address |
| `resultsPerQuery` | `8` | Pages one query's web search returns |
| `maxCandidates` | `16` | Most images on one contact sheet |
| `maxSaved` | `8` | Most images one save takes |
| `maxModelImages` | `4` | Most images one save shows the caller's model |
| `modelImageEdge` | `1024` | Longest side of an image the caller's model receives |
| `pageTimeoutMs` | `10000` | Time limit of reading one page |
| `imageTimeoutMs` | `20000` | Time limit of downloading one image |
| `maxPageBytes` | `2097152` | Bytes of a page read; a longer page is read up to this many |
| `maxImageBytes` | `16777216` | Largest image downloaded |
| `minImageEdge` | `24` | Smallest longest side of an image worth studying, in pixels |
| `sheetCell` | `240` | Side of each image's square on the contact sheet |
| `sheetColumns` | `4` | Most images in one row of the contact sheet |
| `framesMaxFrames` | `24` | Most frames on an animation's frames sheet; a longer animation is sampled evenly |
| `framesMaxEdge` | `1024` | Longest side of an animation's frames sheet |
| `concurrency` | `6` | Pages read and images downloaded at once |

### The tools

`reference_search` takes `queries`, up to four short web searches such as `"knight pixel art sprite"`, and `pages`, up to four web pages to take images from, such as a page the user linked; a call names at least one of either. Each query runs through `ctx.web.search`, the same search `web_search` uses and bills. The search's pages are read on this computer: from each, the image it names for link previews (Open Graph, Twitter card, `image_src`, or schema.org), or else its first large image, and the video it plays, whose poster that image then is. A search result that is itself an image file is taken as it is, and an image address that answers with a page, such as a wiki's file page, gives that page's main image. A page the call names gives every image it shows: image tags with their largest `srcset` source and lazy-loading attributes, picture sources, video posters, and links to image files. A page gives each address once, and at most `maxCandidates` preview images and as many other images. Each image is downloaded and decoded once to check that it is a PNG, JPEG, WebP, GIF, or AVIF image at least `minImageEdge` pixels on its longest side, and only then kept in the cache folder. An image that fails in any way, such as a file cut short that does not decode, counts as unusable and never fails the search; a cached file that no longer decodes is dropped from the cache and downloaded again. A difference hash finds the same picture at another size or on another site, which is kept once. The rest, up to `maxCandidates`, are numbered on a contact sheet: each image fitted into a square over a checkerboard, small pixel art enlarged by a whole multiple without smoothing, with its number in the top-left corner and `GIF 12`, `ANIM 12`, or `VIDEO` in the bottom-left. The sheet is a JPEG file in the cache folder, which the Session's model receives as an image.

The result lists each image's number, title, site, pixel size, file type, frames and length, its address, its page, and its video, after the external-content notice that the web tools use, and gives the Markdown line that shows the contact sheet in the conversation: `![Reference images](<sheet path>)`. The chat renders an absolute image path through the Host's file route.

`reference_save` takes `subject`, what the references are for, which names the folder, and `images`, up to eight image addresses from `reference_search` or from anywhere else, such as an address the user gave, or absolute paths or `file:` URLs of image files on this computer, such as an image the user attached to an answer. It downloads each address or finds it in the cache, reads each file where it is, and writes the image into `references/<subject>/` under the Session's working directory, numbered after the files already there, such as `references/knight/03-pixel-knight-pack.png`. A path or `file:` URL that names another computer, such as `\\host\share\a.png`, `//host/share/a.png`, or `file://host/share/a.png`, is refused on every platform before anything is read, since Windows would connect to that computer with the user's credentials. An animated GIF or WebP also gets `<name>.frames.png`, its frames in a grid, each numbered from 1 with how long it shows, drawn from one pass that decodes the frames up to the last one shown, at most 256 megapixels of frames; a longer or larger animation's sheet samples its first frames that fit, and the result says how many. Each file's title, page, image address, video, and date go into the folder's `SOURCES.md`, whose heading says the images belong to their creators; a file from this computer is listed by its file name alone, without its folders, and without a name when the name is a content hash, as an attachment's is, and saves as `NN-<file name>` or `NN-reference`. An empty `references/.gdignore` keeps Godot from importing the folder, so references never become part of the game or its exports. A save reads and draws every image before it writes anything, so an image that cannot be read or decoded is listed with the images that failed instead of failing the save. Each file then takes the lowest free number only while no other file has its name, so saves that run at once never overwrite each other, and each keeps its lines in `SOURCES.md`; a save that fails or is stopped while it writes removes the files it wrote, and one stopped before it writes writes nothing. An image already in the folder byte for byte is not saved again: the result lists its earlier file, marked saved earlier, and `SOURCES.md` gains no line, so a repeated save adds nothing. The result lists the saved files and the images that failed, and gives the Session's model each saved image, at most `maxModelImages`: a frames sheet as the PNG it was drawn as, and a still image at most `modelImageEdge` pixels on its longest side, a small one enlarged by a whole multiple.

The page and image requests go only to public internet addresses: for the first address and every redirect's, the host is resolved once, every address it resolves to must be a public IPv4 or IPv6 address, including an IPv6 address that carries an IPv4 one (mapped, NAT64, 6to4, or Teredo), and the request connects to one of those addresses rather than to the host name. A host whose records change after the check therefore cannot move the connection to this computer or its local network. When the harness's proxy policy routes the address through an HTTP or HTTPS proxy, the proxy is asked to connect to that address, so it does not resolve the name either. HTTPS checks the site's certificate against its host name. Requests carry no cookies or credentials, follow at most five redirects, and accept gzip, deflate, and Brotli bodies.

### Connected agents

Agents connected through WASD Engine's MCP server reach the tools under the provider `reference`, titled Art references, without a Session. `reference_save` takes `project`, the absolute path of an existing game project folder, and saves into its `references/` folder. Each result sends its images as image bytes after its text.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

A search runs every query's web search at once; a query whose search fails adds nothing while another query or a named page gives sources, and the call fails with the search's message only when every query fails and the call names no page. Sources are the named pages first, then each query's results taken in turn from every query, so each query's best results come first. Pages are read, and then images downloaded, `concurrency` at a time; twice `maxCandidates` images are tried so the sheet fills when some fail or repeat. A page that cannot be read, a page without an image, and an image that fails to download, is not a reference image that decodes, is too small, or fails in any other way count as unusable; the result reports how many, and the plugin logs a failure that is neither the web's nor the file's, such as a cache folder it cannot write. Pictures are decoded at the size they are drawn at, inside sharp's pipeline, so a large image never takes memory at its full size. A save checks its call's cancellation between steps, so its time limit and the user's Stop end it before it writes. Labels on the sheets come from a built-in pixel font, so no system font is needed. Sharp loads at the first call that reads an image.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config, the cache, tool registration, the system prompt section, and the game MCP provider |
| [`src/net.ts`](src/net.ts) | Public address checks and bounded GET requests that follow redirects |
| [`src/transport.ts`](src/transport.ts) | Connections to checked addresses, directly or through the proxy, and their HTTP/1.1 requests |
| [`src/html.ts`](src/html.ts) | Reading a page's preview images, video, title, site, and shown images |
| [`src/finder.ts`](src/finder.ts) | The search, the downloads, duplicate pictures, and the cache folder |
| [`src/images.ts`](src/images.ts) | Image checks, fingerprints, the contact sheet, frames sheets, and the model's copies |
| [`src/save.ts`](src/save.ts) | Subject folders, numbered files, `SOURCES.md`, and `references/.gdignore` |
| [`src/tools.ts`](src/tools.ts) | The tool definitions, argument checks, and result text |
| [`src/prompt.ts`](src/prompt.ts) | The system prompt section and the MCP provider's instructions |
| [`src/mcp.ts`](src/mcp.ts) | The tools for connected agents |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the search the tools use, the image tool that takes the references, and the MCP server that offers the tools to other agents.

- [tool-web](../../web/tool-web/README.md) — the `web_search` tool over the same web search.
- [image-generation](../image-generation/README.md) — `image_generate`, which takes saved references as images to match.
- [game-mcp](../game-mcp/README.md) — the MCP server for agents on this computer.
- [Game tools subsystem page](../../../docs/subsystems/gamedev.md) — the game tools, their rows, and the MCP server.

-----

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

While the Session has `reference_search`, the `art-references` section, under `# Art references`, tells the agent that art made from good references comes out much better and to gather references with `reference_search` before it makes any art asset, without waiting to be asked, unless the user gave references, asked it not to search, or the asset repeats art the game already has. It says how to phrase two to four queries for the subject, its look, and its motion; to always show the user the contact sheet, whether or not it asks anything; to keep a game's existing style and take only the subject from references; to ask which direction the user wants when references differ in style, pixel size, proportions, palette, or view that neither the request nor the game's art decides, with `ask_user_question` when the Session has it and one option per direction, even in the middle of a longer request, and otherwise to go on without asking; that images the user gives, with an answer or in a message, are references the user chose, each with its file path, which it follows first, keeping only the found references that agree with them; to save the references it uses with `reference_save`, the user's images by their file paths, which adds no asset and needs no approval; and to work from them, passing them to `image_generate` when the Session has it, comparing Blender and GIMP work with them, and following an animation's frames sheet. It ends with the rule never to copy a reference, reproduce someone else's character, logo, or artwork, or put a reference image into the game. As the Web and Desktop profiles compose it, with `ask_user_question` and `image_generate`; without `ask_user_question` the question is asked in the reply, one direction per line, and the turn ends to wait for the answer, and without `image_generate` its step is left out.

##### The `art-references` section

```markdown
# Art references

Art made from good references comes out much better. Before you make any art asset, such as a sprite, character, creature, item, icon, tile, texture, background, UI piece, 3D model, animation, or effect, gather references for it with reference_search without waiting to be asked. Skip this only when the user already gave references for it, asks you not to search, or the asset repeats art the game already has, such as another color of an existing item.

- Search for the subject and its look in two to four short queries, such as "armored knight pixel art sprite", "knight sprite sheet walk cycle", and "medieval plate armor". For an animation, search for the motion too, such as "sword slash animation gif" or "walk cycle reference". Pass pages to take the images of a page the user linked or a gallery a search found.
- Always show the user the contact sheet, whether or not you ask them anything: put the Markdown image line the result gives you in your next message, so they see what the art will be based on.
- When the game already has art, keep its style, and take only the subject from the references: its shape, details, colors, and motion.
- Otherwise compare how the references look, not only what they show: art style (pixel art, painted, flat, 3D), pixel size or detail (a 16-pixel sprite against a 64-pixel one), proportions (cute against heroic or realistic), palette and mood, and view (side, top-down, isometric). When they differ in any of these and the request does not say which, ask with ask_user_question which direction they want: one option per direction, labeled with its look and the numbers of the references that show it; the user can also answer with images of their own. Art direction is the user's choice, and a game's first art sets the look of the whole game, so ask even in the middle of a longer request. When the references agree, pick the ones that fit and go on without asking.
- Images the user gives you, with an answer or in a message, are references they chose, and each comes with its file path. Follow them first, and keep only the found references that agree with them.
- Save the references you use with reference_save, the user's images by their file paths. It keeps them in references/, out of the game, so it adds no asset and needs no approval; keep the art you make out of that folder.
- Work from the saved references: pass the one to three references closest to the chosen direction to image_generate in images, and say in the prompt what to take from each, such as the proportions and palette of the first image; compare what you make in Blender or GIMP with them; for an animation, follow the frame count and timing of the frames sheet reference_save makes for a GIF.

References guide shape, proportions, colors, mood, and motion. Describe your own design and never copy a reference: do not reproduce someone else's character, logo, or artwork, and never put a reference image into the game.
```

#### Token effect

The section comes to about 3,000 characters.

#### KV Cache effect

The section changes only when `ask_user_question` or `image_generate` joins or leaves the Session's tools, so it stays in the cached system prompt.

### Tool declarations

#### What the model sees

`reference_search` with the optional `queries` and `pages`, and `reference_save` with `subject` and `images`. The descriptions say what kinds of art the references are for, that each query takes the main image of every page found, including GIF animations and video posters, that the result's contact sheet is shown to the user as a Markdown image, that `reference_save` takes image addresses or the paths of image files on this computer, keeps the images and their sources in `references/<subject>/`, which Godot leaves out of the game, and makes a frames sheet for an animation. A connected agent sees the same tools, `reference_save` with `project`, and the provider's instructions under `## Art references`.

#### Token effect

The two declarations come to about 2,200 characters of JSON; the provider's instructions add about 1,300 characters to the MCP server's instructions.

#### KV Cache effect

The declarations are static, so they stay in the cached tool prefix.

### Tool results

#### What the model sees

A search result is a line on what was found, the contact sheet's path and the Markdown line that shows it, the external-content notice, and two or three lines per image: number, title, site, size, type, frames and length, and its addresses; with the contact sheet as an image when the model takes images. A save result lists each saved file, its frames sheet, or the first frames it covers for a very long animation, `(saved earlier)` for a file an earlier save already holds, and each image that failed with the reason, such as a damaged image file that cannot be decoded, and ends by saying to work from them: to pass the files to `image_generate` in `images` with what to take from each, to compare Blender and GIMP work with them, and to follow a frames sheet's timing; each saved image or frames sheet comes as an image. A failure says what to change: a missing or overlong argument, an address that is not on the public web, a network path, or the web search's own message, such as a signed-out account; a path that names no file or no image is listed with the images that failed.

#### Token effect

A search result is about 100 characters per image, up to 16 images, plus one contact sheet image of about 1,000 by 1,000 pixels. A save result is a line per file, plus up to four images.

#### KV Cache effect

Append-only in the conversation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the tools offer; they are current package constraints.

- **No video frames** — a video stays on the web: the contact sheet shows its poster and the result its address. Frames come only from animated GIF and WebP files.
- **Pages without script** — a page is read as its server sends it, before scripts run, so sites that build their pages in the browser, or answer with a bot check, as Reddit does, give no image.
- **One image per search result** — a search takes each page's main image; a gallery's other images need its address in `pages`.
- **Generic preview images** — a listing or tag page often names a site banner for link previews, which then fills a place on the sheet.
- **Damaged images are skipped** — an image whose data is cut short or damaged counts as unusable, even when a browser would show part of it.
- **Long animations** — a frames sheet decodes at most 256 megapixels of frames, so a very long or large animation's sheet covers only its first frames.
- **Generic conversation rows** — the Web UI shows the calls in the generic tool row; the agent shows the contact sheet in its message.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The plugin uses the web search the user's account already pays for and reads pages and images from this computer, like a browser, so it needs no key of its own. Bing's image API was retired and Google's Custom Search closed to new customers, so an image search API would mean a new paid provider behind the WASD Engine API; the preview images of ordinary search results cover most art references without one.

</details>
