# Extension result ID audit

Reviewed every JavaScript provider under all 20 real extensions. The host calls
`recordSelection(query, result.id, invoke)` before dispatching a selected row,
including pending, error, and no-match rows. It persists the full ID and the
first six lowercased query characters in host-owned search frecency. This
inventory concerns result IDs; settings control IDs and tool/widget action IDs
are not search result IDs.

| Extension | ID content | Privacy assessment |
| --- | --- | --- |
| bookmarks | Bookmark names for add/delete/open; entire no-match query in `bm:none:<q>` | Names and queries can be private or arbitrary pasted secrets. Bookmark URL values are not included. |
| calendar | Native event ID, or fallback `<subject>:<start_time>`; requested date on no-date row | Fallback exposes meeting subject and time; native IDs also identify private events. Meeting URLs are not included. |
| color-picker | Normalized color hex | No credential or private free text. |
| currency | Source/target currency and numeric amount | May reveal a private financial amount or conversion. |
| dev-tools | Translated operation label, or hash algorithm | Input/output, generated UUIDs, Base64 values, and hash values are not included. |
| dictionary | Resolved word and part of speech; suggestion word | Reveals the lookup term. Arbitrary failed input uses a fixed error ID. |
| emoji | Public shortcode, or fixed hint ID | No private free text. |
| focus-tracker | Reporting period, month, process name; site row uses process name and an index | Reveals application activity. Site URL/title values are not included. |
| github | Full pending query, username, numeric issue/repository ID; fixed other rows | Queries can expose private repo names, search text, or accidentally pasted secrets. Settings PAT values are not included. Numeric IDs reveal which repos/issues were selected, including private ones. |
| hello-world | Fixed `hello-world` | No private input. |
| link-preview | No search results (message formatter only) | No result ID path. |
| math | Fixed `math` | Expression/result not included. |
| password | Fixed `pw:password`, `pw:passphrase`, `pw:regen` starting in 1.0.2 | Generated values are no longer included. Earlier IDs contained entire generated passwords/passphrases; existing host records remain until host cleanup. |
| snippets | Snippet names for add/delete/copy | Names can be private or arbitrary pasted secrets. Snippet bodies are not included. |
| spotify | Full play/queue/playlist query, device argument, device ID, volume; fixed command IDs | Reveals listening queries, private playlist/device names, and device identifiers; arbitrary pasted text can include secrets. Auth tokens and saved client input are not included. |
| stocks | Symbol and action/error code | Reveals selected/looked-up securities. API keys are not included. |
| timer | Fixed command type | Duration and arbitrary query content are not included. |
| todos | Generated task IDs, or IDs retained from imported records; fixed action/header IDs | New IDs do not contain task text. Imports accept arbitrary IDs and could therefore carry private text/secrets. IDs identify selected tasks. |
| weather | Full requested/home-location string, including miss rows | Reveals home or queried locations/addresses and any accidentally pasted secret. |
| window-walker | Native window handle | Does not include window titles or application names; identifies a selected window. |

Password was the explicit credential-bearing ID construction found. Other
extensions expose private context and several accept arbitrary text, so result
IDs cannot generally be treated as safe public metadata. Host mitigation should
also consider the six-character query prefixes and existing frecency records.
