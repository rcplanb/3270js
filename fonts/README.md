# The 3270 font (optional)

`3270.css` registers the **3270** font by Ricardo Bánffy
([rbanffy/3270font](https://github.com/rbanffy/3270font), v3.0.1), a modern
version of the fonts x3270 draws with. It is not part of the JavaScript
bundle: link it only if you want the authentic look.

| File                   | Size   |                                                                      |
| ---------------------- | ------ | -------------------------------------------------------------------- |
| `3270-Regular.woff2`   | 64 KB  | made from the release's TTF with `woff2_compress`                    |
| `3270-Regular.woff`    | 109 KB | as released                                                          |
| `LICENSE-3270font.txt` |        | the font's license (BSD-3-Clause; also covers the Debian logo glyph) |

The renderers' default theme lists `"3270"` first, so nothing else is needed.
The canvas renderer re-measures its cells when the font finishes loading.
