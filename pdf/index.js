const functions = require("@google-cloud/functions-framework");
const puppeteer = require("puppeteer");
const sharp = require("sharp");
const { Storage } = require("@google-cloud/storage");
const { PDFDocument, StandardFonts, rgb, PDFRawStream, PDFName, PDFNumber } = require("pdf-lib-plus-encrypt");
const PdfNodeActions = {
  CREATE_PDF_FROM_HTML: "create_pdf_from_html",
  MERGE_PDFS: "merge_pdfs",
};
functions.http("pdfNode", async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed. Only POST requests are allowed.");
    return;
  } else {
    let url = "";
    switch (req.body.action) {
      case PdfNodeActions.CREATE_PDF_FROM_HTML:
        url = await htmlToPdfAction(req.body);
        res.send({
          url: url,
          metadata: req.body.metadata,
        });
        break;
      case PdfNodeActions.MERGE_PDFS:
        url = await mergePdfsAction(
          req.body.pdfs,
          req.body.bucket,
          req.body.password,
          req.body.page_numbers,
          req.body.page_numbers_template
        );
        res.send({
          url: url,
        });
        break;
      default:
        res.status(400).send("Invalid action");
        return;
    }
  }
});
async function htmlToPdfAction(data) {
  const { html, script, bucket, layout, format, height, width, password, header_template, footer_template, margin, viewportWidth, viewportHeight, waitAfterLoadMs } = data;
  const pdfBuffer = await convertHtmlToPdf(
    html,
    script,
    layout,
    format,
    height,
    width,
    password,
    header_template,
    footer_template,
    margin,
    viewportWidth,
    viewportHeight,
    waitAfterLoadMs
  );
  const pdfUrl = await uploadPdfAndGetUrl(pdfBuffer, bucket, password);
  return pdfUrl;
}
// Inflate zlib/deflate bytes — uses DecompressionStream global (Node.js 18+, no require needed)
async function inflateBytes(compressed) {
  const ds = new DecompressionStream("deflate");
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  writer.write(compressed);
  writer.close();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
// Resizes large FlateDecode images to 50% using sharp, then re-deflates.
// Only large images (>=500px each side) benefit — small icons get skipped.
// Uses only globals (DecompressionStream/CompressionStream) + already-imported sharp.
async function compressImagesInPdf(pdfDoc) {
  const { context } = pdfDoc;
  let count = 0;
  let savedBytes = 0;
  for (const [, obj] of context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const subtype = obj.dict.get(PDFName.of("Subtype"));
    if (!subtype || subtype.toString() !== "/Image") continue;
    const filter = obj.dict.get(PDFName.of("Filter"));
    if (!filter || filter.toString() !== "/FlateDecode") continue;
    // Skip images with predictor, masks, or extra decode params
    if (obj.dict.get(PDFName.of("DecodeParms"))) continue;
    if (obj.dict.get(PDFName.of("SMask"))) continue;
    if (obj.dict.get(PDFName.of("Mask"))) continue;
    const wNode = obj.dict.get(PDFName.of("Width"));
    const hNode = obj.dict.get(PDFName.of("Height"));
    if (!wNode || !hNode) continue;
    const w = parseInt(wNode.toString());
    const h = parseInt(hNode.toString());
    if (w < 500 || h < 500) continue; // skip small icons/logos
    const csNode = obj.dict.get(PDFName.of("ColorSpace"));
    const csStr = csNode ? csNode.toString() : "";
    if (csStr.includes("CMYK")) continue;
    const channels = csStr.includes("Gray") ? 1 : 3;
    try {
      const original = Buffer.from(obj.contents);
      const rawPixels = await inflateBytes(original);
      const newW = Math.round(w * 0.6);
      const newH = Math.round(h * 0.6);
      const recompressed = await sharp(rawPixels, { raw: { width: w, height: h, channels } })
        .resize(newW, newH)
        .jpeg({ quality: 85 })
        .toBuffer();
      if (recompressed.length < original.length) {
        obj.contents = new Uint8Array(recompressed);
        obj.dict.set(PDFName.of("Width"), PDFNumber.of(newW));
        obj.dict.set(PDFName.of("Height"), PDFNumber.of(newH));
        obj.dict.set(PDFName.of("Length"), PDFNumber.of(recompressed.length));
        obj.dict.set(PDFName.of("Filter"), PDFName.of("DCTDecode"));
        // Update ColorSpace to match JPEG output (RGB or Gray)
        obj.dict.set(
          PDFName.of("ColorSpace"),
          PDFName.of(channels === 1 ? "DeviceGray" : "DeviceRGB")
        );
        savedBytes += original.length - recompressed.length;
        count++;
      }
    } catch (e) {
      // skip images that cannot be processed
    }
  }
  console.log(`compressImagesInPdf: ${count} images resized to 50%, saved ${(savedBytes / 1024).toFixed(1)} KB`);
}
// Core merge logic — exported so the test file can call it directly without GCS.
async function buildMergedPdf(pdfUrls, password, page_numbers, page_numbers_template) {
  const mergedPdf = await PDFDocument.create();
  for (const url of pdfUrls) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch PDF from ${url}. \n\nMake sure the pdf exists and is accessible.`
      );
    }
    const pdfBytes = await response.arrayBuffer();
    const pdf = await PDFDocument.load(pdfBytes);
    const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
    copiedPages.forEach((page) => mergedPdf.addPage(page));
  }
  if (page_numbers) {
    const pageCount = mergedPdf.getPageCount();
    const helveticaFont = await mergedPdf.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < pageCount; i++) {
      const page = mergedPdf.getPage(i);
      const { width, height } = page.getSize();
      const pageNumberText = page_numbers_template
        ? page_numbers_template.replace("{{page}}", i + 1).replace("{{total_pages}}", pageCount)
        : `${i + 1} / ${pageCount}`;
      page.drawText(pageNumberText, {
        x: width / 2 - helveticaFont.widthOfTextAtSize(pageNumberText, 10) / 2,
        y: 16,
        size: 8,
        font: helveticaFont,
        color: rgb(0, 0, 0),
      });
    }
  }
  // Compress JPEG images in the merged PDF before saving
  await compressImagesInPdf(mergedPdf);
  //encrypt pdf
  if (password) {
    await mergedPdf.encrypt({
      userPassword: String(password),
      permissions: {
        print: true,
        copy: true,
        modify: true,
        annot: true,
        form: true,
      },
    });
  }
  return Buffer.from(await mergedPdf.save({ useObjectStreams: true }));
}
async function mergePdfsAction(pdfUrls, bucket, password, page_numbers, page_numbers_template) {
  const pdfBuffer = await buildMergedPdf(pdfUrls, password, page_numbers, page_numbers_template);
  const pdfUrl = await uploadPdfAndGetUrl(pdfBuffer, bucket);
  return pdfUrl;
}
const docHeight = () => {
  const body = document.body;
  const html = document.documentElement;
  return Math.max(
    body.scrollHeight,
    body.offsetHeight,
    body.clientHeight,
    html.clientHeight,
    html.scrollHeight
  );
};
const docWidth = (docu) => {
  const body = document.body;
  const html = document.documentElement;
  return Math.max(
    body.scrollWidth,
    body.offsetWidth,
    html.clientWidth,
    html.scrollWidth,
    html.offsetWidth
  );
};

async function convertHtmlToPdf(
    htmlData,
    script,
    layout,
    format,
    height,
    width,
    password,
    header_template,
    footer_template,
    margin,
    viewportWidth = 1920,
    viewportHeight = 1080,
    waitAfterLoadMs = 8000,
) {
    const browser = await puppeteer.launch({
        headless: true,   
        args: [
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",    // also no GPU on Cloud Run
            "--no-zygote",
            "--single-process",
        ]
    });
    const page = await browser.newPage();
    
    if (htmlData.includes("streamlit") && viewportWidth && viewportHeight) {
        await page.setViewport({ width: viewportWidth, height: viewportHeight, deviceScaleFactor: 1 });
    }
    if (htmlData.startsWith("http")) {
        let navigated = false;
        try {
            const res = await fetch(htmlData, { redirect: "follow" });
            const disposition = res.headers.get("content-disposition") || "";
            // If the URL triggers a download, Puppeteer's goto will ERR_ABORTED.
            // Fetch the content ourselves and use setContent instead.
            if (disposition.includes("attachment")) {
                const html = await res.text();
                await page.setContent(html, { timeout: 60000, waitUntil: "networkidle2" });
                await new Promise((r) => setTimeout(r, waitAfterLoadMs));
                navigated = true;
            }
        } catch (_) {
            // fetch failed — fall through to normal goto
            console.warn(`Fetch failed falling back to page.goto`);
        }
        if (!navigated) {
            await page.goto(htmlData, {
                waitUntil: 'networkidle0',
                timeout: 60000,
            });
        }
        await new Promise((r) => setTimeout(r, waitAfterLoadMs));
    } else {
        await page.setContent(htmlData, { timeout: 60000, waitUntil: 'networkidle2' });
    }

    if(script){
        await page.evaluate((code) => {
            eval(code);
        }, script);
    }

    let pdfOptions = {
        printBackground: true,
    };

    if (format && format !== "none") {
        pdfOptions.format = format;
    }

    if (layout === "landscape") {
        pdfOptions.landscape = true;
    } else if (layout === "portrait") {
        pdfOptions.portrait = true;
    }

    if (header_template || footer_template) {
        pdfOptions.displayHeaderFooter = true;

        if (header_template) {
            pdfOptions.headerTemplate = header_template;
        }

        if (footer_template) {
            pdfOptions.footerTemplate = footer_template;
        }
    }

    if(margin && (margin.top || margin.right || margin.bottom || margin.left)){
        pdfOptions.margin = {
            top: margin.top || 0,
            right: margin.right || 0,
            bottom: margin.bottom || 0,
            left: margin.left || 0
        }
    }

    if (height && width) {
        pdfOptions.height = height;
        pdfOptions.width = width;
    }
    if (!height && !width && (!format || format === "none")) {
        pdfOptions.width = await page.evaluate(docWidth);
        pdfOptions.height = await page.evaluate(docHeight);
    }

    const padUint8Array = await page.pdf(pdfOptions);
    const pdfBuffer = Buffer.from(padUint8Array);
    await browser.close();

    //encrypt pdf
    if (password) {
        const pdfDoc = await PDFDocument.load(pdfBuffer);
        await pdfDoc.encrypt({
            userPassword: String(password),
            permissions: {
                print: true,
                copy: true,
                modify: true,
                annot: true,
                form: true,
            },
        });
        const doc = await pdfDoc.save();
        return Buffer.from(doc);
    }

    return pdfBuffer;
}

async function uploadPdfAndGetUrl(pdfBuffer, bucketName) {
  try {
    const storage = new Storage({
      keyFilename: "gocobalt-dev.json", //change it using env var
    });
    const bucket = storage.bucket(bucketName);
    const randomEightLetters = Math.random().toString(36).substring(2, 10);
    const fileName = `pdf_${Date.now()}_${randomEightLetters}.pdf`;
    const file = bucket.file(fileName);
    await file.save(pdfBuffer, {
      metadata: {
        contentType: "application/pdf",
      },
    });
    await file.makePublic();
    const publicUrl = file.publicUrl();
    // const expirationDate = new Date();
    // expirationDate.setDate(expirationDate.getDate() + 14); // 14 days from now, file will be deleted
    // await file.setMetadata({
    //   metadata: { autoDeleteDate: expirationDate.toISOString() },
    // });
    return publicUrl;
  } catch (error) {
    console.error("Error uploading PDF and getting URL:", error.message);
    throw error;
  }
}
module.exports = { buildMergedPdf };