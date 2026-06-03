const functions = require("@google-cloud/functions-framework");
const { Storage } = require("@google-cloud/storage");
const Papa = require('papaparse');
const { json2csv } = require('json-2-csv');
const axios = require('axios');
const xlsx = require('xlsx');
const ExcelJS = require('exceljs');
const fs = require("fs");
const path = require("path");
const mime = require('mime-types');

const CsvNodeActions = {
    CSV_TO_JSON: "csv_to_json",
    JSON_TO_CSV: "json_to_csv",
    PARSE_CSV_TO_ARRAY: "parse_csv_to_array",
    ARRAY_OF_ROWS_TO_CSV: "array_of_rows_to_csv",
    JSON_TO_EXCEL: "json_to_excel",
    JSON_DATA_TO_EXCEL: "json_data_to_excel",
    CSV_TO_EXCEL: "csv_to_excel",
    MERGE_EXCEL_FILES: "merge_excel_files",
    BASE64_TO_FILE: "base64_to_file",
    WRITE_DATA_TO_FILE: "write_data_to_file"
}

const bucketName = "csvnode";

functions.http("csvexcel", async (req, res) => {
    if (req.method !== "POST") {
        res.status(405).send("Method Not Allowed. Only POST requests are allowed.");
        return;
    } else {
        try{
            const { action, inputData } = req.body;

            if (!action || !inputData) {
                return res.status(400).send({ error: "Missing 'action' or 'inputData' in request body" });
            }

            let result;
            switch (action) {
                case CsvNodeActions.CSV_TO_JSON:
                    result = await csvToJson(inputData, true);
                    break;
                case CsvNodeActions.JSON_TO_CSV:
                    result = await jsonToCsv(inputData, true);
                    break;
                case CsvNodeActions.PARSE_CSV_TO_ARRAY:
                    result = await csvToJson(inputData);
                    break;
                case CsvNodeActions.ARRAY_OF_ROWS_TO_CSV:
                    result = await jsonToCsv(inputData);
                    break;
                case CsvNodeActions.JSON_TO_EXCEL:
                    result = await jsonToExcel(inputData);
                    break;
                case CsvNodeActions.JSON_DATA_TO_EXCEL:
                    result = await jsonDataToExcel(inputData);
                    break;
                case CsvNodeActions.CSV_TO_EXCEL:
                    result = await csvToExcel(inputData);
                    break;
                case CsvNodeActions.MERGE_EXCEL_FILES:
                    result = await mergeExcelFiles(inputData);
                    break;
                case CsvNodeActions.BASE64_TO_FILE:
                    result = await base64ToFile(inputData);
                    break;
                case CsvNodeActions.WRITE_DATA_TO_FILE:
                    result = await writeDataToFile(inputData);
                    break;
                default:
                    throw new Error("Invalid action");
            }

            res.status(200).send(result);
        } catch(error){
            res.status(500).send({ error: error.message });
        }
    }
});

async function writeDataToFile(inputData) {
    let { data, file_format, file_name, content_type } = inputData;

    if(file_format === "text"){
        file_format = "txt";
    }
    if(file_format === "excel"){
        file_format = "xlsx";
    }

    const fileContentType = content_type || mime.contentType(file_format);

    if(!fileContentType){
        throw new Error("Not able to automatically infer content type. Please provide a valid content type.");
    }

    if(!mime.extension(fileContentType)){
        throw new Error("Invalid content type: " + fileContentType);
    }

    if(file_format === "json"){
        data = JSON.stringify(data);
    }

    const key = file_name + "." + file_format;
    const url = await uploadToGCP(key, data, fileContentType);
    return { url };
}

async function base64ToFile(inputData) {
    const { b64_string, file_format, file_name } = inputData;
    
    if (!b64_string || !file_format) {
        throw new Error("Missing 'b64_string' or 'file_format' in inputData");
    }
    
    if (typeof b64_string !== "string") {
        throw new Error("'b64_string' must be a string");
    }

    let normalizedFormat = file_format;
    if (normalizedFormat === "text") {
        normalizedFormat = "txt";
    }
    if (normalizedFormat === "excel") {
        normalizedFormat = "xlsx";
    }
    if (normalizedFormat.includes("/")) {
        const extension = mime.extension(normalizedFormat);
        if (extension) {
            normalizedFormat = extension;
        }
    }

    const fileContentType = mime.contentType(normalizedFormat);
    
    if (!fileContentType) {
        throw new Error("Not able to automatically infer content type. Please provide a valid file format.");
    }
    
    if (!mime.extension(fileContentType)) {
        throw new Error("Invalid content type: " + fileContentType);
    }
    
    let fileData;
    try {
        const base64Data = b64_string.includes(',') ? b64_string.split(',')[1] : b64_string;
        fileData = Buffer.from(base64Data, 'base64');
    } catch (e) {
        throw new Error("Invalid base64 string: " + e.message);
    }
    
    const key = file_name ? `${file_name}.${normalizedFormat}` : `base64_to_file_${Date.now()}.${normalizedFormat}`;
    const url = await uploadToGCP(key, fileData, fileContentType);
    return { url };
}

async function csvToJson(inputData, uploadToBucket = false) {
    let csv = inputData.csv_input;
    if (inputData.csv_file_url && uploadToBucket) {
        const csvData = await readDataFromUrl(inputData.csv_file_url);
        csv = csvData;
    }

    const { data } = Papa.parse(csv, {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: true,
        transformHeader: (header) => header.trim(),
        transform: (value) => value.trim()
    });

    if (uploadToBucket) {
        const key = "csv_to_json_" + Date.now() + ".json";
        const url = await uploadToGCP(key, JSON.stringify(data), "application/json");
        return { url };
    }

    return { json: data };
}

async function jsonToCsv(inputData, uploadToBucket = false) {
     if (inputData.json_file_url && uploadToBucket) {
        if (typeof inputData.json_file_url === "string" && inputData.json_file_url.startsWith("http")) {
            inputData.rows = await readDataFromUrl(inputData.json_file_url);
        } else {
            inputData.rows = inputData.json_file_url;
        }
    }

    const json = inputData.rows;
    const csv = json2csv(json, {
        emptyFieldValue: '\\N',
        unwindArrays: true
    });

    if (uploadToBucket) {
        const key = "json_to_csv_" + Date.now() + ".csv";
        const url = await uploadToGCP(key, csv, "text/csv");
        return { url };
    }

    return { csv };
}

async function readDataFromUrl(url) {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    const resForOptions = await axios.head(url);
    const contentType = resForOptions.headers['content-type'];

    const contentLength = resForOptions.headers['content-length'];
    if (contentLength && parseInt(contentLength) > 10 * 1024 * 1024) {
        throw new Error(`File size is too large (${(contentLength / (1024 * 1024)).toFixed(2)} mb). Maximum file size allowed is 10 mb.`);
    }

    if (contentType.includes("application/json")) {
        const data = response.data.toString('utf8');
        return JSON.parse(data);
    } else if (
        contentType.includes("text/csv") ||
        contentType.includes("text/plain")
    ) {
        return response.data.toString('utf8');
    } else if (
        contentType.includes("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") ||
        contentType.includes("application/vnd.ms-excel")
    ) {
        return response.data;
    } else {
        throw new Error("Invalid file type");
    }
}

//for json file to excel
async function jsonToExcel(inputData) {
    const { json_file_url, has_formulas } = inputData;
    const jsonData = await readDataFromUrl(json_file_url);

    const { url } = await jsonDataToExcel({ json_data: jsonData, has_formulas });

    return { url };
}

async function jsonDataToExcel(inputData) {
    const { json_data, has_formulas } = inputData;

    if (!Array.isArray(json_data)) {
        throw new Error("Invalid input: 'json_data' must be an array.");
    }

    const flattenedData = json_data.map((item) => flattenObject(item));

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Sheet1');
    const allKeys = Array.from(new Set(flattenedData.flatMap(Object.keys)));
    worksheet.columns = allKeys.map(key => ({ header: key, key }));
    worksheet.addRows(flattenedData);

    if (has_formulas) {
        const tasks = [];

        for (let row = 1; row <= worksheet.rowCount; row++) {
            for (let col = 1; col <= worksheet.columnCount; col++) {
                const cell = worksheet.getCell(row, col);
                if (typeof cell.value === "string" && cell.value.startsWith("=")) {
                    const formula = cell.value;
                    if (!formula.includes("=IMAGE(")) {
                        cell.value = formula.slice(1);
                    } else {
                        const imageMatch = formula.match(/^=IMAGE\(\s*["'](.+?)["']\s*,\s*["'](.*?)["']\s*,\s*3\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
                        if (imageMatch) {
                            const imageUrl = imageMatch[1];
                            const width = parseInt(imageMatch[3]);
                            const height = parseInt(imageMatch[4]);
                            worksheet.getColumn(col).width = width / 6;
                            cell.value = ''; // Clear the formula before attempting image
                            tasks.push({ row, col, imageUrl, width, height, fallbackValue: formula });
                        }
                    }
                }
            }
        }

        const concurrency = 100;
        for (let i = 0; i < tasks.length; i += concurrency) {
            const batch = tasks.slice(i, i + concurrency);
            await Promise.allSettled(
                batch.map(async ({ row, col, imageUrl, width, height, fallbackValue }) => {
                    try {
                        const imageBuffer = (await axios({ method: 'get', url: imageUrl, responseType: 'arraybuffer' })).data;
                        const imageId = workbook.addImage({
                            buffer: imageBuffer,
                            extension: 'jpeg',
                        });
                        worksheet.addImage(imageId, {
                            tl: { col: col - 1, row: row - 1 },
                            ext: { width, height },
                        });
                        worksheet.getRow(row).height = height + 5;
                    } catch (err) {
                        console.log(`Image download failed. Keeping original formula string in cell at row ${row}, col ${col}`);
                        worksheet.getCell(row, col).value = fallbackValue;
                    }
                })
            );
        }
    }

    const buffer = await workbook.xlsx.writeBuffer();
    const key = "json_data_to_excel_" + Date.now() + ".xlsx";
    const url = await uploadToGCP(key, buffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    return { url };
}

async function csvToExcel(inputData) {
    const { csv_file_url, has_formulas } = inputData;
    const csvData = await readDataFromUrl(csv_file_url);
    const { data } = Papa.parse(csvData, {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: true,
        transformHeader: (header) => header.trim(),
        transform: (value) => value.trim()
    });

    const ws = xlsx.utils.json_to_sheet(data);

    if(has_formulas){
        const range = xlsx.utils.decode_range(ws['!ref']);

        for (let row = range.s.r; row <= range.e.r; row++) {
            for (let col = range.s.c; col <= range.e.c; col++) {
                const cellAddress = xlsx.utils.encode_cell({ r: row, c: col });
                const cell = ws[cellAddress];
                if (cell && typeof cell.v === 'string' && cell.v.startsWith('=')) {
                    // If the cell value starts with '=', treat it as a formula
                    // Remove the '=' and set as formula
                    ws[cellAddress] = { t: 'n', f: cell.v.slice(1) };
                }
            }
        }
    }

    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, "Sheet1");

    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const key = "csv_to_excel_" + Date.now() + ".xlsx";
    const url = await uploadToGCP(key, buffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    return { url };
}

function fixIntegerCellFormats(ws) {
    Object.values(ws).forEach(cell => {
        if (cell?.t === 'n' && Number.isInteger(cell.v) && (!cell.z || cell.z === 'General')) {
            cell.z = '0';
        }
    });
}

async function mergeExcelFiles(inputData) {
    if (inputData.excel_files.length > 200) {
        throw new Error("Maximum 200 files can be merged at a time");
    }

    const wb = xlsx.utils.book_new();

    if (inputData.merge_into_single_sheet) {
        // Merge all sheets from all files into one sheet
        let mergedRows = [];
        let headerKeys = null;

        for (const file of inputData.excel_files) {
            const excelData = await readDataFromUrl(file);
            // const wbData = xlsx.read(excelData, { type: 'buffer' });
            const wbData = xlsx.read(excelData, { type: "buffer", cellDates: true, cellNF: true });
            for (const sheetName of wbData.SheetNames) {
                const ws = wbData.Sheets[sheetName];
                const rows = xlsx.utils.sheet_to_json(ws, { defval: "" });
                if (rows.length === 0) continue;

                if (!headerKeys) {
                    headerKeys = Object.keys(rows[0]);
                }
                mergedRows = mergedRows.concat(rows);
            }
        }

        const ws = xlsx.utils.json_to_sheet(mergedRows);
        fixIntegerCellFormats(ws);
        xlsx.utils.book_append_sheet(wb, ws, "Sheet1");
    } else {
        // Default: each sheet from each file becomes a separate sheet
        let sheetIndex = 1;
        for (const file of inputData.excel_files) {
            const excelData = await readDataFromUrl(file);
            // const wbData = xlsx.read(excelData, { type: 'buffer' });
            const wbData = xlsx.read(excelData, { type: "buffer", cellDates: true, cellNF: true });
            wbData.SheetNames.forEach((sheetName) => {
                const ws = wbData.Sheets[sheetName];
                fixIntegerCellFormats(ws);
                const truncatedSheetName = sheetName.substring(0, 27);
                xlsx.utils.book_append_sheet(wb, ws, `${truncatedSheetName}_${sheetIndex}`);
                sheetIndex++;
            });
        }
    }

    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const key = "merged_excel_" + Date.now() + ".xlsx";
    const url = await uploadToGCP(key, buffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    return { url };
}

// Util functions
async function uploadToGCP(key, data, contentType) {
    const storage = new Storage({
        keyFilename: "gocobalt-dev.json",
    });

    const file = storage.bucket(bucketName).file(key);
    await file.save(data, { contentType });
    await file.makePublic();
    return `https://storage.googleapis.com/${bucketName}/${key}`;
}

function flattenObject(obj, parentKey = '', result = {}) {
    for (let key in obj) {
        if (obj.hasOwnProperty(key)) {
            const newKey = parentKey ? `${parentKey}.${key}` : key;
            if (typeof obj[key] === 'object' && obj[key] !== null) {
                flattenObject(obj[key], newKey, result);
            } else {
                result[newKey] = obj[key];
            }
        }
    }
    return result;
}