# Adaptive Streaming (Longer Videos)

A Node.js application that converts video files to adaptive HLS (HTTP Live Streaming) format with multiple quality levels. This service downloads videos from AWS S3, processes them using FFmpeg, and uploads the resulting HLS streams back to S3.

## Features

- **Multi-quality HLS streaming**: Generates multiple bitrate variants (super_low, lower, low)
- **Automatic rotation handling**: Properly handles rotated videos from mobile devices
- **16:9 aspect ratio enforcement**: Adds letterboxing/pillarboxing to maintain consistent aspect ratios
- **Optimized encoding**: Uses efficient FFmpeg settings for fast processing
- **AWS S3 integration**: Seamless download and upload to S3 buckets
- **CloudFront ready**: Outputs URLs ready for CDN distribution

## Prerequisites

- Node.js 20 or higher
- Docker (for containerized deployment)
- AWS account with S3 access
- FFmpeg (handled automatically in Docker)

## Installation

### Local Development

1. Clone the repository:
```bash
git clone <your-repo-url>
cd video-processing-service
```

2. Install dependencies:
```bash
npm install
```

3. Install FFmpeg on your system:
   - **macOS**: `brew install ffmpeg`
   - **Ubuntu/Debian**: `sudo apt update && sudo apt install ffmpeg`
   - **Windows**: Download from [FFmpeg official site](https://ffmpeg.org/download.html)

### Docker Deployment

Build the Docker image:
```bash
docker build -t video-processor .
```

## Configuration

### Environment Variables

The following environment variables are required:

| Variable | Description | Example |
|----------|-------------|---------|
| `EVENT` | JSON string containing the S3 key for processing | `{"s3Key": "path/to/video.mp4"}` |
| `MY_S3_BUCKET` | S3 bucket name where videos are stored | `my-video-bucket` |
| `AWS_REGION` | AWS region for S3 operations | `us-east-1` |
| `AWS_ACCESS_KEY_ID` | AWS access key (if not using IAM roles) | `AKIAIOSFODNN7EXAMPLE` |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key (if not using IAM roles) | `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` |

### AWS IAM Permissions

The service requires the following S3 permissions:

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "s3:GetObject",
                "s3:PutObject",
                "s3:DeleteObject"
            ],
            "Resource": "arn:aws:s3:::your-bucket-name/*"
        }
    ]
}
```

## Usage

### Local Execution

```bash
export EVENT='{"s3Key": "videos/sample-video.mp4"}'
export MY_S3_BUCKET="your-video-bucket"
export AWS_REGION="us-east-1"
node startup.js
```

### Docker Execution

```bash
docker run --rm \
  -e EVENT='{"s3Key": "videos/sample-video.mp4"}' \
  -e MY_S3_BUCKET="your-video-bucket" \
  -e AWS_REGION="us-east-1" \
  -e AWS_ACCESS_KEY_ID="your-access-key" \
  -e AWS_SECRET_ACCESS_KEY="your-secret-key" \
  video-processor
```

### AWS Lambda Deployment

This service is designed to work as an AWS Lambda function. The `handler` function can be directly invoked by Lambda with the appropriate event payload:

```json
{
  "s3Key": "path/to/your/video.mp4"
}
```

## Output Structure

The service generates the following file structure in S3:

```
your-s3-key/hls/
├── master.m3u8              # Main playlist with all quality variants
├── low_master.m3u8          # Playlist with only lower quality variants
├── super_low/
│   ├── index.m3u8          # Playlist for super_low quality
│   └── segment_*.m4s       # Video segments
├── lower/
│   ├── index.m3u8          # Playlist for lower quality
│   └── segment_*.m4s       # Video segments
└── low/
    ├── index.m3u8          # Playlist for low quality
    └── segment_*.m4s       # Video segments
```

## Quality Levels

The service automatically generates three quality levels based on the input video resolution:

- **super_low**: 70-80% of original resolution (HD videos get 70%, others 80%)
- **lower**: 80-100% of original resolution  
- **low**: 100% of original resolution

Bitrates are automatically calculated based on pixel count and quality level.

## Video Processing Features

### Rotation Handling
- Automatically detects video rotation metadata
- Properly handles 90°, 180°, and 270° rotations
- Adjusts dimensions accordingly

### Aspect Ratio Normalization
- Forces all outputs to 16:9 aspect ratio
- Adds letterboxing for landscape videos
- Adds pillarboxing for portrait videos
- Maintains original video content without cropping

### Encoding Optimization
- Uses H.264 codec with optimized settings
- Employs CRF-based quality control
- Implements GOP structure for efficient streaming
- Generates fMP4 segments for better compatibility

## Monitoring and Logging

The service provides detailed console logging for:
- Download progress
- Processing status
- Upload progress
- Error handling and debugging

## Error Handling

The service includes comprehensive error handling for:
- S3 connection issues
- FFmpeg processing errors
- File system operations
- Network timeouts and retries

## Performance Considerations

- Uses streaming uploads to handle large files efficiently
- Implements batched uploads to prevent connection exhaustion
- Creates fresh S3 clients for each operation to avoid connection reuse issues
- Optimizes FFmpeg settings for speed vs. quality balance

## Troubleshooting

### Common Issues

1. **FFmpeg not found**: Ensure FFmpeg is installed and in PATH
2. **S3 permissions**: Verify IAM permissions for bucket access
3. **Memory issues**: Large videos may require more memory allocation
4. **Timeout errors**: Adjust timeout settings for large file processing

### Debug Mode

Enable detailed logging by setting the log level:
```bash
export DEBUG="*"
```

## Support

[Add support information here]
