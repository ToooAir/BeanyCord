# Third-Party Notices

This project (**BeanyCord**) is a derivative work. This file preserves the
required copyright and license notices of the upstream work it descends from, as
mandated by the MIT License.

## Derivation chain

BeanyCord re-implements, in Node.js/TypeScript, the Beanfun **QR-login → OTP**
protocol. That protocol logic traces back through the following lineage:

| Stage | Project | License |
| --- | --- | --- |
| Root (origin) | [`kevin940726/BeanfunLogin`](https://github.com/kevin940726/BeanfunLogin) — original C#/WPF client (2015, archived) | **MIT** — Copyright (c) 2015 Kai Hao |
| Mirror/fork | [`BeanfunLogin/BeanfunLogin`](https://github.com/BeanfunLogin/BeanfunLogin) | MIT (same notice) |
| Rust port (reference consulted) | [`pungin/Beanfun`](https://github.com/pungin/Beanfun) — Tauri/Rust re-implementation | No license file present |
| This project | **BeanyCord** — Node.js/TypeScript port | MIT (see `LICENSE`) |

**Attribution & scope of reliance.** The copyrighted expression BeanyCord builds
on is anchored to the **MIT-licensed root by Kai Hao**. `pungin/Beanfun` was
consulted as a reference for the same protocol; it ships without a license file,
so BeanyCord does not rely on, and avoids copying, any original expression unique
to `pungin/Beanfun` that is not present in the MIT-licensed origin. Protocol
facts (endpoint URLs, request ordering, cipher choice, fixed protocol constants)
are functional and are reproduced as facts, not as protected expression.

If you are a copyright holder in this chain and believe attribution here is
incomplete or incorrect, please open an issue.

---

## kevin940726/BeanfunLogin — MIT License

```
The MIT License (MIT)

Copyright (c) 2015 Kai Hao

Permission is hereby granted, free of charge, to any person obtaining a copy
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
SOFTWARE.
```
