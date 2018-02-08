var gulp = require('gulp');
var sass = require('gulp-sass');

var config = {
    bootstrapDir: './bower_components/bootstrap',
    publicDir: './public',
};

gulp.task('css', function() {
    return gulp.src(config.bootstrapDir + '/scss/bootstrap.scss')
    .pipe(sass({
        includePaths: [config.bootstrapDir + '/assets/scss'],
    }))
    .pipe(gulp.dest(config.publicDir + '/stylesheets'));
});

//gulp.task('fonts', function() {
//    return gulp.src(config.bootstrapDir + '/assets/fonts/**/*')
//    .pipe(gulp.dest(config.publicDir + '/fonts'));
//});
//
//gulp.task('default', ['css', 'fonts']);

gulp.task('default', ['css']);