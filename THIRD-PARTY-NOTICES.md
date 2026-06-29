# 第三方聲明（Third-Party Notices）

本專案（**BeanyCord**）為衍生著作。本檔案依 MIT 授權之要求，保留其所衍生之上游
著作的著作權與授權聲明。

> 注意：下方的 MIT 授權條文依規定須保留**英文原文**；翻譯不具授權效力。本檔案
> 上半部的中文僅為說明用途。

## 衍生鏈

BeanyCord 以 Node.js/TypeScript 重新實作 Beanfun 的 **QR 登入 → OTP** 協定。
該協定邏輯的來源可追溯至以下傳承：

| 階段 | 專案 | 授權 |
| --- | --- | --- |
| 根源（origin） | [`kevin940726/BeanfunLogin`](https://github.com/kevin940726/BeanfunLogin) — 原始 C#/WPF 客戶端（2015，已封存） | **MIT** — Copyright (c) 2015 Kai Hao |
| 鏡像/fork | [`BeanfunLogin/BeanfunLogin`](https://github.com/BeanfunLogin/BeanfunLogin) | MIT（相同聲明） |
| Rust 移植（參考比對） | [`pungin/Beanfun`](https://github.com/pungin/Beanfun) — Tauri/Rust 重新實作 | 未附授權檔 |
| 本專案 | **BeanyCord** — Node.js/TypeScript 移植 | MIT（見 `LICENSE`） |

**歸屬與依據範圍。** BeanyCord 所依據的受著作權保護之表達，錨定於 **Kai Hao 以
MIT 授權的根源**。`pungin/Beanfun` 僅作為相同協定的參考被比對；由於它未附授權檔，
BeanyCord 不依賴、亦避免複製任何 `pungin/Beanfun` 獨有、且不存在於 MIT 授權來源中
的原創表達。協定事實（端點 URL、請求順序、加密選擇、固定協定常數）屬於功能性內容，
是以事實而非受保護之表達的形式被重現。

若你是此衍生鏈中的著作權人，並認為此處的歸屬有不完整或錯誤之處，請開 issue 告知。

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
