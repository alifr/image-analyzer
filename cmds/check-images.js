'use strict';

const _               = require('lodash');
const async           = require('async');
const colors          = require('colors');
const crypto          = require('crypto');
const fs              = require('fs');
const https           = require('https');
const imagemin        = require('imagemin');
const imageminMozjpeg = require('imagemin-mozjpeg');
const imageminPngquant = require('imagemin-pngquant');
const path            = require('path');
const request         = require('request');
const tmp             = require('tmp');
const url             = require('url');
const XLSX            = require('xlsx');


module.exports = AnalyzeImages;


class ImageProcessor {
    constructor(options) {
        this.inputFile = options.inputFile;
        this.outputFile = options.outputFile;
        https.globalAgent.keepAlive = true;
    }

    /**
     * Downloads the image 
     * 
     * @param {any} url
     * @param {any} done
     * 
     * @memberOf ImageProcessor
     */
    _getImage(siteImage, cacheFolderName, done) {

      siteImage.cache_file_path = path.join(cacheFolderName, siteImage.file_name);

      request
        .get({
          uri: 'https://www.cancer.gov' + siteImage.url
        })
        .on('error', (err) => {
          return done(err);
        })
        .pipe(
          fs
          .createWriteStream(siteImage.cache_file_path)
          .on('finish', () => {
            //get file size
            let stats = fs.statSync(siteImage.cache_file_path);
            siteImage.original_size = stats.size;
            done(null);
          })
        )
    }

    _createCacheFolder(siteImage, done) {

      let folderPath = path.join(__dirname, '..', 'image_cache', siteImage.hash);

      fs.mkdir(folderPath, (err) => {
        if (err && err.code != 'EEXIST') {
          return done(err);
        }

        return done(null, folderPath);
      });
    }


    _processSingleImage(siteImage, done) {
      async.waterfall([
        (next) => { this._createCacheFolder(siteImage, next) },
        (cacheFolderName, next) => { this._getImage(siteImage, cacheFolderName, next) }
      ],done);
    }

    _processImages(images, done) {
      async.eachLimit(
        images,
        10,
        this._processSingleImage.bind(this),
        (err, res) => {
          if (err) {
            return done(err);
          }

          return done(null, images);
        }
      )
    }

    _optimizeImages(images, done) {
  
      async.eachLimit(
        images,
        5,
        this._optimizeSingleImage.bind(this),
        (err, res) => {
          if (err) {
            return done(err);
          }

          return done(null, images);
        }
      )
    }
    
    _optimizeSingleImage(siteImage, done) {

      let outputFolder = path.join(__dirname, '..', 'optimized_images', siteImage.hash);
  
      imagemin([siteImage.cache_file_path], outputFolder, {
        plugins: [
          imageminMozjpeg(),
          imageminPngquant()
        ]
      }).then(files => {
        if (files.length <= 0) {
          console.warn(`Issue optimizing ${siteImage.url}`);
          return done(null); //
        }
          siteImage.optimized_file_path = files[0].path;
          let stats = fs.statSync(siteImage.optimized_file_path);

          siteImage.optimized_size = stats.size;
          siteImage.optimization_diff = siteImage.original_size - siteImage.optimized_size;
          siteImage.optimization_pct = siteImage.optimization_diff / siteImage.original_size;
          

          done(null);
      });
    }

    

    _convertPercPubLocToUrl(pub_location) {
      return pub_location.replace(/^live/, "");
    }

    _mapTemplateToField(template) {
      console.log(`|${template}|`);
      switch(template) {
        case "gloBnUtilityImage": return "Utility";
        case "gloBnImage": return "Article Image";
        case "gloBnImage5_Panorama": return "Panorama";
        case "gloBnImage3_Enlarged": return "Enlarged";
        case "gloBnImage4_WideFeature": return "Wide Feature";
        case "gloBnImage2_Thumbnail": return "Thumbnail";
        default: return "UNK";
      }
    }

    /**
     * 
     * Parses the XLSX input file and creates a collection of images to analyze
     * 
     * @param {any} done
     * 
     * @memberOf ImageProcessor
     */
    _parseInputFile(done) {
        let workbook = XLSX.readFile(this.inputFile);

        /* Get worksheet */
        let worksheet = workbook.Sheets["path"];

        let sheetObj = XLSX.utils.sheet_to_json(worksheet);

        //Rip through the spreadsheet and create a list of images to process.
        let images = sheetObj.map(
          (imgRow) => {
            let url = this._convertPercPubLocToUrl(imgRow["location"]);
            //Create a tmp foldername based on the md5 hash of the file
            let md5Hasher = crypto.createHash('md5');
            md5Hasher.update(url);
            let folderName = md5Hasher.digest('hex');

            let siteImage = {
              content_id: imgRow["CONTENT_ID"],
              image_type: imgRow["contenttypename"],
              image_field: this._mapTemplateToField(imgRow["template"]),
              template: imgRow["template"],
              url: url,        
              file_name: path.basename(url),
              image_file_type: path.extname(url),
              hash: folderName,
              cache_file_path: '',
              optimized_file_path: '',
              original_size: -1,
              optimized_size: -1,
              optimization_diff: 0,
              optimization_pct: 0  
            };

            return siteImage;
        });

        done(null, images);
    }


    process(done) {

      async.waterfall([
        (next) => { this._parseInputFile(next) },
        (images, next) => { this._processImages(images, next) },
        (images, next) => { this._optimizeImages(images, next) }
      ], (err, res) => {

        if (err) {
          return done(err);
        }

        //Save
        this._saveWorkbook(
          res, 
          [
            'content_id',
            'image_type',
            'image_field',
            'template',
            'url',
            'original_size',
            'optimized_size',
            'optimization_diff',
            'optimization_pct'
          ], 
          done
        );
      });
    }

    _saveWorkbook(data, COLS, done) {
        let wb = {};
        wb.Sheets = {};
        wb.SheetNames = [];

        let ws_name = "Sheet1";

        let ws = {};

        let range = {s: {c:0, r:0}, e: {c:0, r:0 }};

        for(let R = 0; R != data.length; ++R) {
            if (range.e.r < R) range.e.r = R;
            for(var C = 0; C != COLS.length; ++C) {
                if (range.e.c < C) range.e.c = C;

                /* create cell object: .v is the actual data */
                var cell = { v: data[R][COLS[C]] };
                if(cell.v == null) continue;

                /* create the correct cell reference */
                var cell_ref = XLSX.utils.encode_cell({c:C,r:R});

                /* determine the cell type */
                if(typeof cell.v === 'number') cell.t = 'n';
                else if(typeof cell.v === 'boolean') cell.t = 'b';
                else cell.t = 's';

                /* add to structure */
                ws[cell_ref] = cell;
            }            
        }

        ws['!ref'] = XLSX.utils.encode_range(range);

        /* add worksheet to workbook */
        wb.SheetNames.push(ws_name);
        wb.Sheets[ws_name] = ws;

        /* write file */
        XLSX.writeFile(wb, this.outputFile);

        done();        
    }

}

function AnalyzeImages(program) {

    process.env.UV_THREADPOOL_SIZE = 128;
    program
        .command('check-images <input> <output>')
        .version('0.0.1')
        .description(' \
            Processes a spreadsheet containing image paths and \
            analyzes how much benefit would be gained by optimizing those images. \
        ')
        .action((input, output, cmd) => {
            let processor = new ImageProcessor({
                inputFile: input,
                outputFile: output
            });

            try {
                processor.process((err, res) => {
                    if (err) {
                        throw err;
                    }
 
                    //Exit
                    console.log("Finished.  Exiting...")
                    process.exit(0);
                });
            } catch (err) {
                console.error(colors.red(err.message));
                console.error(colors.red("Errors occurred.  Exiting"));
                process.exit(1);
            }
        })
}