# 疊印工具包：如何安裝

疊印工具包 © TeleportPress。線上疊印色彩矩陣：https://teleportpress-letterpress-user-docu.vercel.app/#overprint-matrix

## 這是什麼

三個在 Claude Code 裡使用的工具，一個接一個用：

- **疊印色盤**（overprint-palette）：挑幾支 Pantone 油墨，算出它們疊在一起會印出哪些顏色，並提醒哪兩格太像、印出來分不清楚。算好的色盤存成 palette.json。
- **疊印插畫**（overprint-illustration）：照 palette.json 寫好指令，交給 AI 繪圖工具，畫出只用這四支油墨就印得出來的插畫。
- **分色**（overprint-separation）：把插畫拆成四塊印版，一支油墨一塊，再做一張印刷模擬，送印前先看效果。不用 Claude Code 也能用，見下面「在瀏覽器裡分色」。

## 您需要

- Claude Code
- Python 3.10 以上。第一次使用時，Claude 會自己安裝需要的套件。
- 疊印插畫另外需要一個 AI 繪圖工具（例如 Adobe Firefly）。想讓 Claude 直接操作 Firefly，還需要 Chrome 和 Claude in Chrome 擴充功能。

## 安裝

1. 把壓縮檔解壓縮到 Claude Code 的 skills 資料夾：
   - Mac／Linux：`~/.claude/skills/`
   - Windows：`C:\Users\<您的使用者名稱>\.claude\skills\`
   解壓縮後，skills 資料夾裡會有 overprint-palette、overprint-illustration、overprint-separation 三個資料夾。
   從 GitHub（github.com/uthmod/overprint-kit）下載的話，把這三個資料夾複製到 skills 資料夾。
2. 重新開啟 Claude Code。

## 怎麼用

直接用平常說話的方式告訴 Claude，例如：

- 「幫我找一組四色疊印色盤，要有 806 U」
- 「用 palette.json 畫一張愛麗絲小插畫」
- 「用 palette.json 幫我把 art.png 分色」

## 您的色盤

投票確認信裡的「下載這組色盤」就是您投的那組色盤的 palette.json，存到電腦上，告訴 Claude 它在哪裡就能用。想試別的油墨組合，可以用疊印色盤，或打開上面的線上疊印色彩矩陣產生器，它也能匯出 palette.json。

## 自己畫圖：色票檔

想在繪圖軟體裡自己畫，請告訴 Claude「把 palette.json 轉成色票檔」。它會做出三個檔案，每個都有這組色盤的 16 個顏色：

- `.ase`：Illustrator、Photoshop、InDesign、Affinity。四支油墨是特別色色票，Illustrator 可以直接輸出每支油墨的印版。
- `.swatches`：iPad 上的 Procreate，在 iPad 上打開檔案就會加進調色盤。
- `.gpl`：GIMP、Krita、Inkscape。

畫的時候每一塊都用這 16 個顏色之一平塗；兩支油墨疊在一起的地方，直接用那一格的疊色色票，不要用半透明圖層疊出來；白色的地方留白就是紙色。畫好存成 PNG，再請 Claude 用同一個 palette.json 分色。

## 在瀏覽器裡分色

不用 Claude Code 也能分色：用瀏覽器打開 `overprint-separation/web/index.html`，上傳您的圖、選色盤（或載入 palette.json），就能下載四塊印版和一張印刷模擬。圖片只在您的電腦上處理，不會上傳。投票的朋友在工具包信裡也會收到線上版的連結。

瀏覽器版和 Claude Code 版的分色用同一套算法：我們用五張範例圖比對過，兩邊分出的印版每一點都相同。瀏覽器版少了 `--print` 和 `--screen` 這兩個進階選項，而且最多處理大約 180 萬像素的圖（更大的會自動縮小，很細的淺色線可能因此不見），需要時請用 Claude Code 版。

## 授權

- 疊印工具包以 CC BY-NC 4.0 授權：https://creativecommons.org/licenses/by-nc/4.0/deed.zh-hant 。可以自由使用和修改，但不能用在商業用途，並請保留上面那行出處。
- 不包含 Pantone 色票數值（overprint-palette/pantone-u.csv）：那些是近似值，不屬於我們，無法授權。電腦算出的顏色僅供參考，實際顏色以印刷打樣為準。
