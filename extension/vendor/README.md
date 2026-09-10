# Bundled PDF dependencies

These files are shipped locally. No CDN or remote PDF-generation service is used.
Do not replace them with floating-version URLs. Keep the accompanying licenses.

| Component | Pinned source | Bundled file SHA-256 |
| --- | --- | --- |
| jsPDF 4.2.1 (MIT) | [Official project](https://github.com/parallax/jsPDF), npm `jspdf@4.2.1`, `dist/jspdf.umd.min.js` | `e6551fcdc32f09d6853b2c5126d18d01d9447e0da618a41a11ebeee0f6c20d54` |
| jsPDF-AutoTable 5.0.8 (MIT) | [Official project](https://github.com/simonbengtsson/jsPDF-AutoTable), npm `jspdf-autotable@5.0.8`, `dist/jspdf.plugin.autotable.min.js` | `a65dff2c6a8296b16aff24e69f7683cd7dbaed4a4ec26b507d6840ee27d54649` |
| DejaVu Sans 2.37 (Bitstream Vera license; DejaVu changes public domain) | [Official release](https://github.com/dejavu-fonts/dejavu-fonts/releases/tag/version_2_37), `ttf/DejaVuSans.ttf` | `7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954` |
| DejaVu Sans Bold 2.37 (same license) | Same official release, `ttf/DejaVuSans-Bold.ttf` | `e6476c1b80502924294eed40894c5b18e06c181444ca953e5334262df9c27724` |

Official npm tarball SHA-512 integrity:

- jsPDF: `sha512-YyAXyvnmjTbR4bHQRLzex3CuINCDlQnBqoSYyjJwTP2x9jDLuKDzy7aKUl0hgx3uhcl7xzg32agn5vlie6HIlQ==`
- AutoTable: `sha512-Hy05N86yBO7CXBrnSLOge7i1ZYpKH2DjQ94iybaP7vBhSInjvRBgDc99ngKzSbSO8Jc98ZCally8I6n0tj2RJQ==`

Official font release archive `dejavu-fonts-ttf-2.37.zip` SHA-256:
`7576310b219e04159d35ff61dd4a4ec4cdba4f35c00e002a136f00e96a908b0a`.

Only the browser bundles, two fonts, and licenses are distributed. MuPDF used to
render synthetic PDFs during development is a temporary QA tool, not a runtime
dependency and is not shipped in the extension folder.
