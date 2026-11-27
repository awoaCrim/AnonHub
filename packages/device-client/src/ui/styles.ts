/** Bundled local asset; no external requests or runtime asset directory. */
export const dashboardStyle = String.raw`
:root {
  font:
    15px/1.6 system-ui,
    -apple-system,
    "Segoe UI",
    sans-serif;
  color: #202c36;
  background: #f3f6f7;
  color-scheme: light;
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
}
header {
  background: #fff;
  border-bottom: 1px solid #dfe6e9;
  padding: 18px 6%;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
header > div {
  display: flex;
  align-items: center;
  gap: 14px;
}
.brand {
  background: #166c64;
  color: white;
  display: grid;
  place-items: center;
  border-radius: 10px;
  width: 32px;
  height: 32px;
  font-weight: 800;
}
main {
  max-width: 920px;
  margin: auto;
  padding: 32px 20px 40px;
}
.hero {
  padding: 8px 4px 28px;
}
.eyebrow {
  color: #166c64;
  font-weight: 650;
  font-size: 13px;
}
h1 {
  font-size: 32px;
  margin: 8px 0;
}
h2 {
  font-size: 20px;
  margin: 0 0 20px;
}
h3 {
  font-size: 16px;
  margin-top: 24px;
}
p {
  margin: 8px 0 14px;
}
label {
  display: block;
  font-size: 14px;
  font-weight: 550;
  margin: 16px 0;
}
input:not([type=checkbox]),
textarea,
select {
  display: block;
  width: 100%;
  padding: 11px 12px;
  border: 1px solid #cbd6da;
  border-radius: 8px;
  background: white;
  color: #202c36;
  font: inherit;
  margin-top: 6px;
}
textarea {
  min-height: 90px;
  resize: vertical;
}
input:focus,
textarea:focus,
select:focus,
button:focus-visible {
  outline: 2px solid #188a7d;
  outline-offset: 2px;
}
input[type=checkbox] {
  accent-color: #166c64;
  width: 17px;
  height: 17px;
  flex-shrink: 0;
}
.card {
  position: relative;
  padding: 25px 28px;
  background: #fff;
  border: 1px solid #dfe6e9;
  border-radius: 14px;
  margin-bottom: 20px;
}
.step {
  float: right;
  color: #166c64;
  background: #eaf5f1;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-weight: 700;
}
.columns,
.cap-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.choice {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  border: 1px solid #dfe6e9;
  border-radius: 10px;
  padding: 15px;
  margin: 0;
}
.choice small {
  display: block;
  font-size: 12px;
  font-weight: 400;
  color: #5d707a;
  margin-top: 4px;
}
.choice:has(input:checked) {
  background: #f0f8f5;
  border-color: #166c64;
}
.muted,
footer,
.save-bar p {
  color: #63747c;
  font-size: 13px;
}
.mono {
  font: 12px/1.8 ui-monospace, monospace;
  overflow-wrap: anywhere;
}
.actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
button {
  border: 1px solid #bdcccf;
  border-radius: 8px;
  padding: 10px 16px;
  background: white;
  font: inherit;
  font-size: 14px;
  cursor: pointer;
  color: #25363c;
}
button:hover {
  background: #eef4f3;
}
.primary {
  background: #166c64;
  color: #fff;
  border-color: #166c64;
}
.primary:hover {
  background: #11584f;
}
.danger {
  color: #a23838;
  border-color: #dcb9b9;
}
button:disabled,
fieldset:disabled {
  opacity: .6;
  cursor: default;
}
.badge {
  background: #edf2f3;
  border-radius: 20px;
  padding: 5px 13px;
  font-size: 13px;
}
.badge.online {
  background: #dbf3e7;
  color: #185d3c;
}
fieldset {
  border: 0;
  padding: 0;
  margin: 0;
  min-width: 0;
}
.check,
.tool-list label {
  display: flex;
  gap: 8px;
  align-items: center;
}
.tool-list label {
  font-weight: 400;
  font-size: 13px;
  margin: 10px 0;
}
.actor {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  border-top: 1px solid #edf1f2;
  padding: 14px 0;
}
.actor label {
  margin: 0;
  font-size: 12px;
}
.actor button {
  align-self: end;
}
.save-bar {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: center;
  margin: 8px 0 24px;
}
.save-bar p {
  max-width: 560px;
  margin: 0;
}
#notice {
  padding: 14px 18px;
  border: 1px solid #9ccdbb;
  background: #eaf5f1;
  border-radius: 10px;
  margin-bottom: 20px;
}
#notice.error {
  background: #fff1ee;
  border-color: #dcaca2;
  color: #8b3430;
}
footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 30px;
}
[hidden] {
  display: none !important;
}
@media (max-width: 650px) {
  main {
    padding: 22px 14px;
  }
  .columns,
  .cap-grid {
    grid-template-columns: 1fr;
  }
  .actor {
    grid-template-columns: 1fr 1fr;
  }
  .card {
    padding: 22px 18px;
  }
  h1 {
    font-size: 26px;
  }
  .save-bar {
    align-items: flex-start;
    flex-direction: column;
  }
  header {
    padding: 14px 18px;
  }
  header .muted {
    display: none;
  }
}
`;
