# Third-party sources of registry fixtures

Outbound TCP port 43 was blocked on the development network, so most WHOIS fixtures were reconstructed from replies published in other projects' test data. The replies themselves are registry output; queried names were replaced with random 24-character labels where the reply echoes them. Each fixture's `provenance.notes` names the exact source file, revision and capture date.

| Project | Revision | License | Used for |
| --- | --- | --- | --- |
| [klkvsk/whoeasy](https://github.com/klkvsk/whoeasy) | a8347b8011 | Apache-2.0, Copyright 2024 Mike Kulakovsky ([license](licenses/klkvsk-whoeasy-license.txt)) | Most ccTLD WHOIS replies (registered, not found, rate limited) |
| [likexian/whois-parser](https://github.com/likexian/whois-parser) | 2426ff1 | Apache-2.0, Copyright 2014-2026 Li Kexian ([license](licenses/likexian-whois-parser-license.txt)) | .eu, .cn and Identity Digital (.io) replies |
| [prodxpdev/titlesearch](https://github.com/prodxpdev/titlesearch) | e87bb1a596 | Apache-2.0, Copyright 2026 ProdXP LLC ([license](licenses/prodxpdev-titlesearch-license.txt), [notice](licenses/prodxpdev-titlesearch-notice.txt)) | .me and .us registered replies |
| [flipbit/whois](https://github.com/flipbit/whois) | 5f24f6b754 | MIT, Copyright (c) 2012 Chris Wood ([license](licenses/flipbit-whois-license.txt)) | .ws not-found reply |
| [mboot-github/WhoisDomain](https://github.com/mboot-github/WhoisDomain) | a89d4da170 | MIT, Copyright (c) 2023 Maarten Boot ([license](licenses/mboot-github-WhoisDomain-license.txt)) | Cross-checks of reply formats |
| [nmetluk/whois-watcher](https://github.com/nmetluk/whois-watcher) | d717eb366a | MIT, Copyright (c) 2026 Whois Watcher contributors ([license](licenses/nmetluk-whois-watcher-license.txt)) | One short not-found registry reply, used verbatim |

The license texts (and the Apache NOTICE file of titlesearch) in [licenses/](licenses/) apply to the excerpts taken from these projects. Reconstructed fixtures are modified excerpts: each fixture's `provenance.notes` states what was changed (queried names replaced with random 24-character labels, registrars, nameservers and dates made synthetic, contact data removed). No code from these projects is included in Domain Scout.

Registry terms-of-use text (RDAP notices and WHOIS banner paragraphs) and real contact details (addresses, phone numbers, email addresses) are replaced in every fixture, live captures included; status and record lines are kept as the registries sent them.
