const functions = require("@google-cloud/functions-framework");
const axios = require("axios");

functions.http("driveUpload", async (req, res) => {
  if (req.method === "GET") {
    res.send("Hello World GET request");
  } else if (req.method === "POST") {
    console.log("Request body", req.body);
    const response = await multipart_file_upload(req.body);
    res.send(response);
  }
});

const uploadEventEnum = {
  file_size_exceeded: "file_size_exceeded",
  file_upload_success: "file_upload_success",
  chunk_upload_success: "chunk_upload_success",
  chunk_upload_failed: "chunk_upload_failed",
  file_not_found: "file_not_found",
};

async function multipart_file_upload({ data, auth }) {
  try {
    if (!data?.multipartSize || data?.multipartSize > 10) {
      data.multipartSize = 10;
    }
    const {
      fileName,
      fileId,
      parentFolderId,
      fileUrl,
      webhookUrl,
      multipartSize,
      metadata,
    } = data;

    const fileMetadata = { name: fileName };
    if (parentFolderId) {
      fileMetadata.parents = [parentFolderId];
    }

    const response = await axios.head(fileUrl);
    const fileSize = response.headers["content-length"];
    const fileSizeInMb = fileSize / (1024 * 1024);

    if (fileSizeInMb > 100) {
      throw new Error("File size should be less than 100MB");
    }
    console.log("File not greater than 100 mb", fileSize);

    const chunkSize = multipartSize * 1024 * 1024;
    const numberOfChunks = Math.ceil(fileSize / chunkSize);

    let start = 0;
    let end = chunkSize;
    let chunkIndex = 0;
    let resumableURL = null;
    // let retriesForChunk = 2;

    const headResponse = await axios.head(fileUrl);
    const initiateResumableUpload = async () => {
      const initialChunk = await getChunk(fileUrl, start, end);
      console.log("Initial chunk size:", initialChunk.length);
      const accessToken = await getAccessToken(
        auth.refresh_token,
        auth.client_id,
        auth.client_secret
      );
      const config = {
        method: "POST",
        url: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          "X-Upload-Content-Type": headResponse.headers["content-type"],
          "X-Upload-Content-Length": fileSize,
        },
        data: {
          name: fileName,
          parents: [parentFolderId],
          mimeType: headResponse.headers["content-type"],
        },
      };
      //   console.log("Config is ", config);
      const response = await axios(config);
      resumableURL = response.headers["location"];
      //   console.log("Resumable URL:", resumableURL);
    };
    console.log("Resumable URL formed");

    await initiateResumableUpload();

    while (start < fileSize) {
      const chunk = await getChunk(fileUrl, start, end);
      const shouldContinue = await uploadChunk({
        chunk,
        start,
        end,
        fileSize,
        resumableURL,
        chunkIndex,
        numberOfChunks,
        webhookUrl,
        fileId,
        fileUrl,
        metadata,
      });
      if (shouldContinue !== true) {
        return shouldContinue; //return google drive response and end the loop and function
      }

      start = end;
      end = Math.min(end + chunkSize, fileSize);
      chunkIndex++;
      retriesForChunk = 2;
      console.log(`Uploaded chunk ${chunkIndex} of ${numberOfChunks}`);
    }

    console.log("File uploaded successfully");
    return { message: "File uploaded successfully" };
  } catch (err) {
    console.error("MAIN UPLOAD ERROR", err);
    return err.message;
    // console.error("Eror code", err.response.status);
  }
}

const getChunk = async (url, start, end, isLastChunk = false) => {
  console.log("Fetching chunk:", start, end);
  //get specific range of bytes from the file and responseType stream
  const response = await axios.get(url, {
    headers: {
      Range: isLastChunk
        ? `bytes=${start}-${end}`
        : `bytes=${start}-${end - 1}`,
    },
    responseType: "stream",
  });
  console.log("Chunk size:", response.headers["content-length"]);
  return response.data;
};

const uploadChunk = async ({
  chunk,
  start,
  end,
  fileSize,
  resumableURL,
  chunkIndex,
  numberOfChunks,
  webhookUrl,
  fileId,
  fileUrl,
  metadata,
}) => {
  try {
    const currentChunkSize = end - start;
    const chunkUploadRes = await axios.put(resumableURL, chunk, {
      headers: {
        "Content-Length": currentChunkSize,
        "Content-Range": `bytes ${start}-${end - 1}/${fileSize}`,
      },
    });
    console.log(
      "SUCCESS IN UPLOAD",
      chunkUploadRes.data,
      chunkUploadRes.status
    );
    if (chunkUploadRes.status === 200 || chunkUploadRes.status === 201) {
      console.log(`File uploaded successfully`);
      await fireWebhook(webhookUrl, {
        status: uploadEventEnum.file_upload_success,
        fileId: fileId,
        fileUrl: fileUrl,
        metadata: metadata,
        status_code: chunkUploadRes.status,
        chunkIndex: chunkIndex + 1,
        totalChunks: numberOfChunks,
      });
      return chunkUploadRes.data; // Break the loop
    }
  } catch (chunkError) {
    console.log(
      `\n inside error part of uploadChunk`,
      chunkError?.response?.status,
      chunkError?.response?.data
    );
    if (chunkError?.response?.status === 308) {
      console.log(
        `Chunk ${chunkIndex + 1} uploaded successfully`,
        chunkError.response.headers["range"]
      );
      await fireWebhook(webhookUrl, {
        status: uploadEventEnum.chunk_upload_success,
        fileId: fileId,
        fileUrl: fileUrl,
        metadata: metadata,
        status_code: chunkError?.response?.status,
        chunkIndex: chunkIndex + 1,
        totalChunks: numberOfChunks,
      });
      return true; // Continue loop
    } else if (chunkError?.response?.status === 503) {
      console.log(`\n inside 503 error part`);
      await fireWebhook(webhookUrl, {
        status: uploadEventEnum.chunk_upload_failed,
        fileId: fileId,
        fileUrl: fileUrl,
        metadata: metadata,
        status_code: chunkError?.response?.status,
        error: chunkError?.response?.data,
        chunkIndex: chunkIndex + 1,
        totalChunks: numberOfChunks,
      });
      throw new Error(`Failed to upload chunk ${chunkIndex} due to 503 error`);
    } else {
      console.log(`\n inside else part of errors`, chunkError);
      await fireWebhook(webhookUrl, {
        status: uploadEventEnum.chunk_upload_failed,
        fileId: fileId,
        fileUrl: fileUrl,
        metadata: metadata,
        status_code: chunkError?.response?.status,
        error: chunkError?.response?.data,
        chunkIndex: chunkIndex + 1,
        totalChunks: numberOfChunks,
      });
      throw new Error(
        chunkError.message || `Failed to upload chunk ${chunkIndex}`
      );
    }
  }
  return true; // Continue loop
};

const fireWebhook = async (url, data) => {
  try {
    if (url) {
      await axios.post(url, data);
    }
  } catch (err) {
    console.error(
      "Webhook error" + err.message || `Unable to fire the webhook`
    );
  }
};

const getAccessToken = async (refreshToken, clientId, clientSecret) => {
  try {
    const response = await axios.post(`https://oauth2.googleapis.com/token`, {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
    return response.data.access_token;
  } catch (err) {
    throw new Error(err.message || `Unable to get the access token`);
  }
};
