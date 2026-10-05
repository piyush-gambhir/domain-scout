# Third-party sources of registry fixtures

Outbound TCP port 43 was blocked on the development network, so most WHOIS fixtures were reconstructed from replies published in other projects' test data. The replies themselves are registry output; queried names were replaced with random 24-character labels where the reply echoes them. Each fixture's `provenance.notes` names the exact source file, revision and capture date.

| Project | License | Used for |
| --- | --- | --- |
| [klkvsk/whoeasy](https://github.com/klkvsk/whoeasy) | MIT | Most ccTLD WHOIS replies (registered, not found, rate limited) |
| [likexian/whois-parser](https://github.com/likexian/whois-parser) | Apache-2.0 | .eu, .cn and Identity Digital (.io) replies |
| [prodxpdev/titlesearch](https://github.com/prodxpdev/titlesearch) | Apache-2.0 | .me and .us registered replies |
| [flipbit/whois](https://github.com/flipbit/whois) | MIT | .ws not-found reply |
| [mboot-github/WhoisDomain](https://github.com/mboot-github/WhoisDomain) | MIT | Cross-checks of reply formats |
| [nmetluk/whois-watcher](https://github.com/nmetluk/whois-watcher) | Not recorded | One short not-found registry reply, used verbatim |

The copyright notices and license texts of these projects apply to the excerpts taken from them. No code from these projects is included in Domain Scout.
