import { S3Client, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import ffmpeg from 'fluent-ffmpeg'; // Default import for CommonJS
const { ffprobe } = ffmpeg; // Destructure ffprobe from the default import
import {
  existsSync,
  mkdirSync,
  createWriteStream,
  writeFileSync,
  readdirSync,
  lstatSync,
  unlinkSync,
  rmdirSync,
  readFileSync,
} from 'fs';
import { join } from 'path';

const createS3Client = () => {
  return new S3Client({ 
    region: process.env.AWS_REGION,
    maxAttempts: 5
  });
};
// Similarly update the download function to use a fresh client
const downloadFile = (bucket, key, outputPath) => {
  console.log(`Starting download from s3://${bucket}/${key} to ${outputPath}`);
  return new Promise((resolve, reject) => {
    // Create a fresh S3 client for this download operation
    const freshS3Client = createS3Client();
    
    const params = { Bucket: bucket, Key: key };
    const fileStream = createWriteStream(outputPath);

    fileStream.on('error', err => {
      console.error(`Error writing to file ${outputPath}: ${err.message}`);
      reject(err);
    });

    freshS3Client.send(new GetObjectCommand(params))
      .then(data => {
        data.Body.pipe(fileStream)
          .on('error', err => {
            console.error(`Error downloading file from s3://${bucket}/${key}: ${err.message}`);
            reject(err);
          })
          .on('close', () => {
            console.log(`Successfully downloaded file to ${outputPath}`);
            resolve();
          });
      })
      .catch(err => {
        console.error(`Error downloading file from s3://${bucket}/${key}: ${err.message}`);
        reject(err);
      });
  });
};

const getVideoResolution = filePath => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        console.error(`Error probing video file ${filePath}: ${err.message}`);
        reject(err);
      } else {
        const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
        if (videoStream) {
          const resolution = {
            width: videoStream.width,
            height: videoStream.height,
            displayAspectRatio: videoStream.display_aspect_ratio,
            sampleAspectRatio: videoStream.sample_aspect_ratio,
            rotation: videoStream.rotation || 0 // Default to 0 if no rotation data
          };

          if(resolution.rotation ==  90 || resolution.rotation == -90)
          {
            [resolution.width,resolution.height] = [resolution.height, resolution.width]
          }
          
          console.log('Video metadata:', JSON.stringify(resolution, null, 2));
          resolve({ width: resolution.width, height: resolution.height });
        } else {
          reject(new Error('No video stream found'));
        }
      }
    });
  });
};


const generateHlsStream = (inputFilePath, outputDir, width, height, bitrate, name, rotation = 0) => {
  return new Promise((resolve, reject) => {
    const streamOutputDir = join(outputDir, name);
    const outputM3u8Path = join(streamOutputDir, 'index.m3u8');

    mkdirSync(streamOutputDir, { recursive: true });

    console.log(`Generating HLS stream for resolution ${width}x${height} at ${streamOutputDir}`);

    // Adjust CRF values (slightly higher for faster encoding)
    const crf = name.includes('low') ? 18 : name.includes('lower') ? 23 : name.includes('super_low') ? 25 : 23;

    // Use a faster preset
    const preset = name.includes('low') ? 'medium' : 'veryfast';  // Can change to 'fast' or 'medium' for better quality

    // Adjust GOP size (4 seconds at 30fps)
    const gopSize = 4 * 30;

    // Adjust audio bitrates
    const audioBitrate = name.includes('low') ? '96k' : name.includes('lower') ? '64k' : '48k';

    // Adjust video bitrates
    const videoBitrate = Math.round(bitrate * 1);
    const maxBitrate = Math.round(videoBitrate * 1.5);
    const bufferSize = `${maxBitrate * 2}k`;

    // Force 16:9 aspect ratio with letterboxing or pillarboxing
    // For videos that are already in portrait mode (e.g., mobile videos)
    // Calculate for 16:9 without reducing dimensions
    let aspectRatioFilter;
    
    // First, determine the proper output dimensions to maintain 16:9
    // We need to ensure the output resolution isn't smaller than input in either dimension
    const isPortrait = height > width;
    
    let targetWidth, targetHeight;
    
    if (isPortrait) {
      // For portrait videos, keep the height and calculate width for 16:9
      targetHeight = height;
      targetWidth = Math.round((height * 16) / 9);
    } else {
      // For landscape videos, keep the width and calculate height for 16:9
      targetWidth = width;
      targetHeight = Math.round((width * 9) / 16);
    }
    
    // Ensure dimensions are even
    targetWidth = targetWidth % 2 === 0 ? targetWidth : targetWidth + 1;
    targetHeight = targetHeight % 2 === 0 ? targetHeight : targetHeight + 1;
    
    console.log(`Calculated 16:9 dimensions: ${targetWidth}x${targetHeight} for input ${width}x${height}`);
    
    // Now create the filter based on rotation
    if (rotation === 90 || rotation === -90 || rotation === 270) {
      // For rotated videos, first transpose then apply the aspect ratio
      const transposeMode = (rotation === 90 || rotation === -270) ? 1 : 2; // 1 = 90°, 2 = 270°
      aspectRatioFilter = `transpose=${transposeMode},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1:1`;
    } else if (rotation === 180) {
      // For 180° rotation
      aspectRatioFilter = `hflip,vflip,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1:1`;
    } else {
      // For normal videos (no rotation)
      aspectRatioFilter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1:1`;
    }

    const outputOptions = [
      `-vf ${aspectRatioFilter}`,
      `-c:v libx264`,
      `-crf ${crf}`,
      `-preset ${preset}`,
      `-g ${gopSize}`,
      `-keyint_min ${Math.round(gopSize / 2)}`,
      `-sc_threshold 0`,
      `-b:v ${videoBitrate}k`,
      `-maxrate ${maxBitrate}k`,
      `-bufsize ${bufferSize}`,
      '-c:a aac',
      `-b:a ${audioBitrate}`,
      '-ac 2',
      '-ar 44100',
      '-movflags +faststart',
      '-f hls',
      '-hls_time 4',
      '-hls_list_size 0',
      '-hls_segment_type fmp4',
      '-hls_playlist_type vod',
      '-hls_flags independent_segments',
      '-pix_fmt yuv420p',
      `-hls_segment_filename`, `${streamOutputDir}/segment_%03d.m4s`
    ];

    // Optimized x264 params for faster encoding
    const x264Params = [
      'no-fast-pskip=1',
      'no-dct-decimate=1',
      'aq-mode=1',
      'aq-strength=0.8',
      'psy-rd=1.0',
      'deblock=1:1',
      'me=hex',
      'subme=7',
      'trellis=2',
      'ref=3',
      'b-adapt=2',
      'bframes=3',
    ].join(':');

    outputOptions.push('-x264-params', x264Params);

    if (name.includes('lower') || name.includes('super_low')) {
      outputOptions.push('-r', '24'); // Reduce framerate for very low qualities
    }

    ffmpeg(inputFilePath)
      .outputOptions(outputOptions)
      .output(outputM3u8Path)
      .on('start', (commandLine) => {
        console.log('Spawned FFmpeg with command:', commandLine);
      })
      .on('progress', (progress) => {
        console.log(`Processing: ${progress.percent}% done`);
      })
      .on('end', () => {
        console.log(`HLS stream generation complete for resolution ${targetWidth}x${targetHeight} at ${streamOutputDir}`);
        resolve();
      })
      .on('error', (err, stdout, stderr) => {
        console.error(`Error generating HLS stream for resolution ${targetWidth}x${targetHeight}: ${err.message}`);
        console.error('ffmpeg stdout:', stdout);
        console.error('ffmpeg stderr:', stderr);
        reject(err);
      })
      .run();
  });
};
const calculateTargetDimensions = (width, height) => {
  // Determine if the video is in portrait or landscape mode
  const isPortrait = height > width;
  
  let targetWidth, targetHeight;
  
  if (isPortrait) {
    // For portrait videos, keep the height and calculate width for 16:9
    targetHeight = height;
    targetWidth = Math.round((height * 16) / 9);
  } else {
    // For landscape videos, keep the width and calculate height for 16:9
    targetWidth = width;
    targetHeight = Math.round((width * 9) / 16);
  }
  
  // Ensure dimensions are even
  targetWidth = targetWidth % 2 === 0 ? targetWidth : targetWidth + 1;
  targetHeight = targetHeight % 2 === 0 ? targetHeight : targetHeight + 1;
  
  return { width: targetWidth, height: targetHeight };
};

const appendToMasterM3u8 = async (newResolutions, outputDir) => {
  const masterPlaylistPath = join(outputDir, 'master.m3u8');
  let masterContent = ['#EXTM3U', '#EXT-X-VERSION:4'];

  newResolutions.forEach(res => {
    // Calculate 16:9 dimensions for the playlist
    const targetDims = calculateTargetDimensions(res.width, res.height);
    
    const resolutionLine = `#EXT-X-STREAM-INF:BANDWIDTH=${res.bitrate * 1000},RESOLUTION=${targetDims.width}x${targetDims.height}`;
    masterContent.push(resolutionLine);
    masterContent.push(`${res.name}/index.m3u8`);
    console.log(`Added resolution ${targetDims.width}x${targetDims.height} to master playlist`);
  });

  writeFileSync(masterPlaylistPath, masterContent.join('\n'));
  console.log(`Master playlist created at ${masterPlaylistPath}`);
};

const appendToLowMasterM3u8 = async (resolutions, outputDir) => {
  const lowMasterPlaylistPath = join(outputDir, 'low_master.m3u8');
  let masterContent = ['#EXTM3U', '#EXT-X-VERSION:4'];

  resolutions
    .filter(res => res.name === 'lower' || res.name === 'super_low')
    .forEach(res => {
      // Calculate 16:9 dimensions for the playlist
      const targetDims = calculateTargetDimensions(res.width, res.height);
      
      const resolutionLine = `#EXT-X-STREAM-INF:BANDWIDTH=${res.bitrate * 1000},RESOLUTION=${targetDims.width}x${targetDims.height}`;
      masterContent.push(resolutionLine);
      masterContent.push(`${res.name}/index.m3u8`);
      console.log(`Added resolution ${targetDims.width}x${targetDims.height} to low master playlist`);
    });

  writeFileSync(lowMasterPlaylistPath, masterContent.join('\n'));
  console.log(`Low master playlist created at ${lowMasterPlaylistPath}`);
};

const emptyDirectory = dirPath => {
  if (existsSync(dirPath)) {
    readdirSync(dirPath).forEach(file => {
      const currentPath = join(dirPath, file);
      if (lstatSync(currentPath).isDirectory()) {
        emptyDirectory(currentPath);
        rmdirSync(currentPath);
      } else {
        unlinkSync(currentPath);
      }
    });
    console.log(`Emptied directory: ${dirPath}`);
  }
};

const uploadSingleFile = async (bucket, key, filePath) => {
  const freshS3Client = createS3Client();
  const fileContent = readFileSync(filePath);
  
  try {
    const upload = new Upload({
      client: freshS3Client,
      params: {
        Bucket: bucket,
        Key: key,
        Body: fileContent,
      },
    });
    
    await upload.done();
    console.log(`Uploaded ${filePath} to s3://${bucket}/${key}`);
  } catch (error) {
    console.error(`Error uploading ${filePath} to ${bucket}/${key}: ${error.message}`);
    throw error;
  }
};

// Update uploadToS3 to use very small batches to prevent socket exhaustion
const uploadToS3 = async (bucket, key, filePath) => {
  const freshS3Client = createS3Client();
  
  if (lstatSync(filePath).isDirectory()) {
    const files = readdirSync(filePath);
    
    // Process directories and m3u8 files first (they're small and critical)
    const directories = files.filter(file => lstatSync(join(filePath, file)).isDirectory());
    const playlists = files.filter(file => file.endsWith('.m3u8'));
    const segments = files.filter(file => !directories.includes(file) && !playlists.includes(file));
    
    console.log(`Uploading directory ${filePath} with ${directories.length} subdirs, ${playlists.length} playlists, and ${segments.length} segments`);
    
    // First upload directories (recursive calls)
    for (const dir of directories) {
      const fullPath = join(filePath, dir);
      const dirKey = `${key}/${dir}`;
      await uploadToS3(bucket, dirKey, fullPath);
    }
    
    // Then upload playlist files
    for (const playlist of playlists) {
      const fullPath = join(filePath, playlist);
      const fileKey = `${key}/${playlist}`;
      await uploadSingleFile(bucket, fileKey, fullPath);
    }
    
    // Then upload segments in very small batches to prevent socket exhaustion
    const BATCH_SIZE = 40; // Use only 10 connections at a time
    for (let i = 0; i < segments.length; i += BATCH_SIZE) {
      const batch = segments.slice(i, i + BATCH_SIZE);
      console.log(`Uploading segment batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(segments.length/BATCH_SIZE)}`);
      
      // Process this batch concurrently
      await Promise.all(batch.map(file => {
        const fullPath = join(filePath, file);
        const fileKey = `${key}/${file}`;
        return uploadSingleFile(bucket, fileKey, fullPath);
      }));
    }
  } else {
    await uploadSingleFile(bucket, key, filePath);
  }
};

const deleteFromS3 = async (bucket, key) => {
  const freshS3Client = createS3Client();
  const command = new DeleteObjectCommand({ Bucket: bucket, Key: key });
  await freshS3Client.send(command);
  console.log(`Deleted s3://${bucket}/${key}`);
};

const extractPartsFromUrl = url => {
  const regex = /https:\/\/[^/]+\/(.+\/InteractiveVideos\/([^/]+))_(mergedVideo_\d+\.mp4)/;
  const match = url.match(regex);
  if (match && match[1] && match[2] && match[3]) {
    return {
      baseKeyPrefix: match[1],
      uuid: match[2],
      inputKey: `${match[1]}_${match[3]}`,
    };
  } else {
    throw new Error('URL parts not found');
  }
};
const getAdjustedResolutions = (originalWidth, originalHeight) => {
  const isPortrait = originalHeight > originalWidth;
  const aspectRatio = originalWidth / originalHeight;
  const isHD = isPortrait ? originalWidth >= 720 : originalHeight >= 720;

  const scaleResolution = (scale) => {
    let newWidth = Math.round(originalWidth * scale);
    let newHeight = Math.round(newWidth / aspectRatio);

    // Ensure even dimensions
    newWidth = newWidth % 2 === 0 ? newWidth : newWidth - 1;
    newHeight = newHeight % 2 === 0 ? newHeight : newHeight - 1;

    return { width: newWidth, height: newHeight };
  };



  const calculateBitrate = (width, height, quality) => {
    const pixels = width * height;
    let bitrate;

    switch (quality) {
      case 'low':
        bitrate = Math.max(4000, Math.min(10000, pixels / 300));
        break;
      case 'mid':
        bitrate = Math.max(2000, Math.min(6000, pixels / 600));
        break;
      case 'lower':
        bitrate = Math.max(1000, Math.min(3000, pixels / 1600));
        break;
      case 'high':
        bitrate = Math.max(200, Math.min(1500, pixels / 1800));
        break;
      default:
        bitrate = Math.max(100, Math.min(800, pixels / 2400));
        break;
    }


    return Math.round(bitrate);
  };

  const resolutions = [
    { ...scaleResolution(isHD ? 0.7 : 0.8), name: 'super_low' },
    { ...scaleResolution(isHD ? 0.8 : 1), name: 'lower' },
    { ...scaleResolution(1), name: 'low' },
  ];

  return resolutions.map(res => ({
    ...res,
    width: res.width % 2 === 0 ? res.width : res.width - 1,
    height: res.height % 2 === 0 ? res.height : res.height - 1,
    bitrate: calculateBitrate(res.width, res.height, res.name)
  }));
};

const processVideo = async event => {
  const s3Bucket = process.env.MY_S3_BUCKET;
  const { s3Key } = event;

  if (!s3Bucket || !s3Key) {
    throw new Error('s3Bucket or s3Key not provided');
  }

  console.log('Starting video processing');
  const outputDir = join('/tmp', 'output');
  const inputPath = join(outputDir, 'input.mp4');

  try {
    console.log('Creating output directory');
    mkdirSync(outputDir, { recursive: true });

    console.log('Downloading file from S3');
    await downloadFile(s3Bucket, s3Key, inputPath);

    console.log('Getting video resolution');
    // Get video metadata including rotation
    const metadata = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(inputPath, (err, metadata) => {
        if (err) {
          console.error(`Error probing video file ${inputPath}: ${err.message}`);
          reject(err);
        } else {
          const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
          if (videoStream) {
            const resolution = {
              width: videoStream.width,
              height: videoStream.height,
              displayAspectRatio: videoStream.display_aspect_ratio,
              sampleAspectRatio: videoStream.sample_aspect_ratio,
              rotation: videoStream.rotation || 0 // Default to 0 if no rotation data
            };

            // Adjust width/height for rotated videos
            if(resolution.rotation == 90 || resolution.rotation == -90 || resolution.rotation == 270) {
              [resolution.width, resolution.height] = [resolution.height, resolution.width];
            }
            
            console.log('Video metadata:', JSON.stringify(resolution, null, 2));
            resolve(resolution);
          } else {
            reject(new Error('No video stream found'));
          }
        }
      });
    });

    console.log(`Original video resolution: ${metadata.width}x${metadata.height}, rotation: ${metadata.rotation}`);

    console.log('Generating HLS streams');
    const resolutions = getAdjustedResolutions(metadata.width, metadata.height);
    
    // Pass the rotation information to generateHlsStream
    await Promise.all(resolutions.map(res =>
      generateHlsStream(inputPath, outputDir, res.width, res.height, res.bitrate, res.name, metadata.rotation)
    ));

    console.log('Generating master playlist');
    await appendToMasterM3u8(resolutions, outputDir);

    console.log('Generating low master playlist');
    await appendToLowMasterM3u8(resolutions, outputDir);

    console.log('Deleting input file');
    unlinkSync(inputPath);

    console.log('Uploading to S3');
    const s3OutputPrefix = `${s3Key}/hls`;
    await uploadToS3(s3Bucket, s3OutputPrefix, outputDir);

    const masterPlaylistUrl = `https://d198g8637lsfvs.cloudfront.net/${s3OutputPrefix}/master.m3u8`;

    console.log('Video processing completed successfully');
    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Video processing completed successfully', masterPlaylistUrl }),
    };
  } catch (error) {
    console.error('Error processing video:', error);
    emptyDirectory(outputDir);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'Error processing video', error: error.message, stack: error.stack }),
    };
  } finally {
    console.log('Cleaning up temporary files');
    emptyDirectory(outputDir);
  }
};




export async function handler(event) {
  return processVideo(event);
}