// ==UserScript==
// @name         WME State DOT Reports (beta)
// @namespace    https://greasyfork.org/users/45389
// @version      2018.02.27.001
// @description  Display state transportation department reports in WME.
// @author       MapOMatic
// @license      GNU GPLv3
// @include      /^https:\/\/(www|beta)\.waze\.com\/(?!user\/)(.{2,6}\/)?editor\/?.*$/
// @grant        GM_xmlhttpRequest
// @connect      511.ky.gov
// @connect      indot.carsprogram.org
// @connect      hb.511ia.org
// @connect      ohgo.com
// @connect      hb.511.nebraska.gov
// @connect      hb.511.idaho.gov
// @connect      hb.511la.org
// @connect      hb.511mn.org
// @connect      511.dot.ri.gov
// @connect      tims.ncdot.gov
// @connect      apps.dot.state.nc.us
// ==/UserScript==

/* global $ */
/* global OL */
/* global GM_info */
/* global W */
/* global GM_xmlhttpRequest */
/* global unsafeWindow */
/* global Components */
/* global I18n */

(function() {
    'use strict';

    var _settingsStoreName = 'dot_report_settings';
    var _alertUpdate = false;
    var _debugLevel = 0;
    var _scriptVersion = GM_info.script.version;
    var _scriptVersionChanges = [
        GM_info.script.name + '\nv' + _scriptVersion + '\n\nWhat\'s New\n------------------------------\n',
        '\n- Added Copy To Clipboard button on report popups.'
    ].join('');
    var _previousZoom;
    var _imagesPath = 'https://raw.githubusercontent.com/mapomatic/ky511-images/master';
    var _mapLayer = null;
    var _settings = {};
    var _dotInfo = {
        IA: { mapType: 'cars', baseUrl: 'https://hb.511ia.org', reportUrl: '/#allReports/eventAlbum/', reportsFeedUrl: '/tgevents/api/eventReports' },
        ID: { mapType: 'cars', baseUrl: 'https://hb.511.idaho.gov', reportUrl: '/#roadReports/eventAlbum/', reportsFeedUrl: '/tgevents/api/eventReports' },
        IN: { mapType: 'cars', baseUrl: 'https://indot.carsprogram.org', reportUrl: '/#roadReports/eventAlbum/', reportsFeedUrl: '/tgevents/api/eventReports' },
        LA: { mapType: 'cars', baseUrl: 'https://hb.511la.org', reportUrl: '/#roadReports/eventAlbum/', reportsFeedUrl: '/tgevents/api/eventReports' },
        MN: { mapType: 'cars', baseUrl: 'https://hb.511mn.org', reportUrl: '/#roadReports/eventAlbum/', reportsFeedUrl: '/tgevents/api/eventReports' },
        NE: { mapType: 'cars', baseUrl: 'https://hb.511.nebraska.gov', reportUrl: '/#roadReports/eventAlbum/', reportsFeedUrl: '/tgevents/api/eventReports' },
    };
    var _tabDiv = {};  // stores the user tab div so it can be restored after switching back from Events mode to Default mode
    var _reports = [];
    var _lastShownTooltipDiv;
    var _tableSortKeys = [];
    var _states = '{"AL":"Alabama","AK":"Alaska","AS":"American Samoa","AZ":"Arizona","AR":"Arkansas","CA":"California","CO":"Colorado","CT":"Connecticut","DE":"Delaware","DC":"District Of Columbia","FM":"Federated States Of Micronesia","FL":"Florida","GA":"Georgia","GU":"Guam","HI":"Hawaii","ID":"Idaho","IL":"Illinois","IN":"Indiana","IA":"Iowa","KS":"Kansas","KY":"Kentucky","LA":"Louisiana","ME":"Maine","MH":"Marshall Islands","MD":"Maryland","MA":"Massachusetts","MI":"Michigan","MN":"Minnesota","MS":"Mississippi","MO":"Missouri","MT":"Montana","NE":"Nebraska","NV":"Nevada","NH":"New Hampshire","NJ":"New Jersey","NM":"New Mexico","NY":"New York","NC":"North Carolina","ND":"North Dakota","MP":"Northern Mariana Islands","OH":"Ohio","OK":"Oklahoma","OR":"Oregon","PW":"Palau","PA":"Pennsylvania","PR":"Puerto Rico","RI":"Rhode Island","SC":"South Carolina","SD":"South Dakota","TN":"Tennessee","TX":"Texas","UT":"Utah","VT":"Vermont","VI":"Virgin Islands","VA":"Virginia","WA":"Washington","WV":"West Virginia","WI":"Wisconsin","WY":"Wyoming"}';
    var _columnSortOrder = ['priority','beginTime.time','eventDescription.descriptionHeader','icon.image','archived'];

    function log(message, level) {
        if (message && level <= _debugLevel) {
            console.log('DOT Reports: ' + message);
        }
    }

    function copyToClipboard(report) {
        debugger;
        // create hidden text element, if it doesn't already exist
        var targetId = "_hiddenCopyText_";
        //var isInput = elem.tagName === "INPUT" || elem.tagName === "TEXTAREA";
        var origSelectionStart, origSelectionEnd;
        var target;

        // must use a temporary form element for the selection and copy
        target = document.getElementById(targetId);
        if (!target) {
            target = document.createElement("textarea");
            target.style.position = "absolute";
            target.style.left = "-9999px";
            target.style.top = "0";
            target.id = targetId;
            document.body.appendChild(target);
        }
        var startTime = new Date(report.beginTime.time);
        var lastUpdateTime = new Date(report.updateTime.time);

        var $content = $('<div>').html([report.eventDescription.descriptionHeader + '<br/><br/>',
                                        report.eventDescription.descriptionFull + '<br/><br/>',
                                        'Start Time: ' + startTime.toString('MMM d, y @ h:mm tt') + '<br/>',
                                        'Updated:' + lastUpdateTime.toString('MMM d, y @ h:mm tt')].join(''));
                                        $(target).val($content[0].innerText || $content[0].textContent);

        // select the content
        var currentFocus = document.activeElement;
        target.focus();
        target.setSelectionRange(0, target.value.length);

        // copy the selection
        var succeed;
        try {
            succeed = document.execCommand("copy");
        } catch(e) {
            succeed = false;
        }
        // restore original focus
        if (currentFocus && typeof currentFocus.focus === "function") {
            currentFocus.focus();
        }

        target.textContent = "";
        return succeed;
    }

    function createSavableReport(reportIn) {
        var attributesToCopy = ['agencyAttribution','archived','beginTime','editorIdentifier','eventDescription','headlinePhrase',
                                'icon','id','location','priority','situationUpdateKey','starred','updateTime'];

        var reportOut = {};
        attributesToCopy.forEach(function(attr) {
            reportOut[attr] = reportIn[attr];
        });

        return reportOut;
    }
    function copyToSavableReports(reportsIn) {
        var reportsOut = {};
        for (var id in reportsIn) {
            reportsOut[id] = createSavableReport(reportsIn[id]);
        }
        return reportsOut;
    }

    function saveSettingsToStorage() {
        if (localStorage) {
            var settings = {
                lastVersion: _scriptVersion,
                layerVisible: _mapLayer.visibility,
                state: _settings.state,
                hideArchivedReports: $('#hideDotArchivedReports').is(':checked'),
                hideWazeReports: $('#hideDotWazeReports').is(':checked'),
                hideNormalReports: $('#hideDotNormalReports').is(':checked'),
                hideWeatherReports: $('#hideDotWeatherReports').is(':checked'),
                hideCrashReports: $('#hideDotCrashReports').is(':checked'),
                hideWarningReports: $('#hideDotWarningReports').is(':checked'),
                hideClosureReports: $('#hideDotClosureReports').is(':checked'),
                hideRestrictionReports: $('#hideDotRestrictionReports').is(':checked'),
                hideFutureReports: $('#hideDotFutureReports').is(':checked'),
                hideCurrentReports: $('#hideDotCurrentReports').is(':checked'),
                archivedReports:_settings.archivedReports,
                starredReports:copyToSavableReports(_settings.starredReports)
            };
            localStorage.setItem(_settingsStoreName, JSON.stringify(settings));
            log('Settings saved', 1);
        }
    }

    function dynamicSort(property) {
        var sortOrder = 1;
        if(property[0] === "-") {
            sortOrder = -1;
            property = property.substr(1);
        }
        return function (a,b) {
            var props = property.split('.');
            props.forEach(function(prop) {
                a = a[prop];
                b = b[prop];
            });
            var result = (a < b) ? -1 : (a > b) ? 1 : 0;
            return result * sortOrder;
        };
    }

    function dynamicSortMultiple() {
        /*
     * save the arguments object as it will be overwritten
     * note that arguments object is an array-like object
     * consisting of the names of the properties to sort by
     */
        var props = arguments;
        if (arguments[0] && Array.isArray(arguments[0])) {
            props = arguments[0];
        }
        return function (obj1, obj2) {
            var i = 0, result = 0, numberOfProperties = props.length;
            /* try getting a different result from 0 (equal)
         * as long as we have extra properties to compare
         */
            while(result === 0 && i < numberOfProperties) {
                result = dynamicSort(props[i])(obj1, obj2);
                i++;
            }
            return result;
        };
    }

    function getReport(reportId) {
        for (var i=0; i<_reports.length; i++) {
            if (_reports[i].id === reportId) { return _reports[i]; }
        }
    }

    function isHideOptionChecked(reportType) {
        return $('#hideDot' + reportType + 'Reports').is(':checked');
    }

    function updateReportsVisibility() {
        hideAllReportPopovers();
        var hideArchived = isHideOptionChecked('Archived');
        var hideWaze = isHideOptionChecked('Waze');
        var hideNormal = isHideOptionChecked('Normal');
        var hideWeather = isHideOptionChecked('Weather');
        var hideCrash = isHideOptionChecked('Crash');
        var hideWarning = isHideOptionChecked('Warning');
        var hideRestriction = isHideOptionChecked('Restriction');
        var hideClosure = isHideOptionChecked('Closure');
        var hideFuture = isHideOptionChecked('Future');
        var hideCurrent = isHideOptionChecked('Current');
        var visibleCount = 0;
        _reports.forEach(function(report) {
            var img = report.icon.image;
            var now = Date.now();
            var start = new Date(report.beginTime.time);
            var hide =
                hideArchived && report.archived ||
                hideWaze && img.indexOf('waze') > -1 ||
                hideNormal && img.indexOf('driving-good') > -1 ||
                hideWeather && (img.indexOf('weather') > -1 || img.indexOf('flooding') > -1) ||
                hideCrash && img.indexOf('crash') > -1 ||
                hideWarning && (img.indexOf('warning') > -1 || img.indexOf('lane_closure') > -1) ||
                hideRestriction && img.indexOf('restriction') > -1 ||
                hideClosure && img.indexOf('closure') > -1 ||
                hideFuture && start > now ||
                hideCurrent && start <= now;
            if (hide) {
                report.dataRow.hide();
                if (report.imageDiv) { report.imageDiv.hide(); }
            } else {
                visibleCount += 1;
                report.dataRow.show();
                if (report.imageDiv) { report.imageDiv.show(); }
            }
        });
        $('.dot-report-count').text(visibleCount + ' of ' + _reports.length + ' reports');
    }

    function hideAllPopovers($excludeDiv) {
        _reports.forEach(function(rpt) {
            var $div = rpt.imageDiv;
            if ((!$excludeDiv || $div[0] !== $excludeDiv[0]) && $div.data('state') === 'pinned') {
                $div.data('state', '');
                $div.popover('hide');
            }
        });
    }

    function deselectAllDataRows() {
        _reports.forEach(function(rpt) {
            rpt.dataRow.css('background-color','white');
        });
    }

    function toggleMarkerPopover($div) {
        hideAllPopovers($div);
        if ($div.data('state') !== 'pinned') {
            var id = $div.data('reportId');
            var report = getReport(id);
            $div.data('state', 'pinned');
            W.map.moveTo(report.marker.lonlat);
            $div.popover('show');
            if (report.archived) {
                $('.btn-archive-dot-report').text("Un-Archive");
            }
            $('.btn-archive-dot-report').click(function() {setArchiveReport(report,!report.archived, true); buildTable();});
            $('.btn-open-dot-report').click(function(evt) {evt.stopPropagation(); window.open($(this).data('dotReportUrl'),'_blank');});
            $('.btn-zoom-dot-report').click(function(evt) {evt.stopPropagation(); W.map.moveTo(getReport($(this).data('dotReportid')).marker.lonlat); W.map.zoomTo(4);});
            $('.btn-copy-dot-report').click(function(evt) {evt.stopPropagation(); copyToClipboard(getReport($(this).data('dotReportid')));});
            $('.reportPopover,.close-popover').click(function(evt) {evt.stopPropagation(); hideAllReportPopovers();});
            //$(".close-popover").click(function() {hideAllReportPopovers();});
            $div.data('report').dataRow.css('background-color','beige');
        } else {
            $div.data('state', '');
            $div.popover('hide');
        }
    }

    function toggleReportPopover($div) {
        deselectAllDataRows();
        toggleMarkerPopover($div);
    }

    function hideAllReportPopovers() {
        deselectAllDataRows();
        hideAllPopovers();
    }

    function setArchiveReport(report, archive, updateUi) {
        report.archived = archive;
        if (archive) {
            _settings.archivedReports[report.id] = {updateNumber: report.situationUpdateKey.updateNumber};
            report.imageDiv.addClass('dot-archived-marker');
        }else {
            delete _settings.archivedReports[report.id];
            report.imageDiv.removeClass('dot-archived-marker');
        }
        if (updateUi) {
            saveSettingsToStorage();
            updateReportsVisibility();
            hideAllReportPopovers();
        }
    }

    function setStarReport(report, star, updateUi) {
        report.starred = star;
        if (star) {
            if (!_settings.starredReports) { _settings.starredReports = {}; }
            _settings.starredReports[report.id] = report;
            report.imageDiv.addClass('dot-starred-marker');
        } else {
            delete _settings.starredReports[report.id];
            report.imageDiv.removeClass('dot-starred-marker');
        }
        if (updateUi) {
            saveSettingsToStorage();
            updateReportsVisibility();
            hideAllReportPopovers();
        }

    }

    function archiveAllReports(unarchive) {
        _reports.forEach(function(report) {
            setArchiveReport(report, !unarchive, false);
        });
        saveSettingsToStorage();
        buildTable();
        hideAllReportPopovers();
    }

    function addRow($table, report) {
        var $img = $('<img>', {src:report.imgUrl, class:'table-img'});
        var $row = $('<tr> class="clickable"', {id:'dot-row-'+report.id}).append(
            $('<td class="centered">').append(
                $('<span>', {class:'star ' + (report.starred ? 'star-filled':'star-empty'),title:'Star if you want notification when this report is removed by the DOT.\nFor instance, if a map change needs to be undone after a closure report is removed.'}).click(
                    function (evt) {
                        evt.stopPropagation();
                        setStarReport(report,!report.starred,true);
                        var $this = $(this);
                        $this.removeClass(report.starred ? 'star-empty' : 'star-filled');
                        $this.addClass(report.starred ? 'star-filled' : 'star-empty');
                    }))).append(
            $('<td>',{class:'centered'}).append(
                $('<input>',{type:'checkbox',title:'Archive (will automatically un-archive if report is updated by DOT)',id:'archive-' + report.id, 'data-report-id':report.id}).prop('checked', report.archived).click(
                    function(evt){
                        evt.stopPropagation();
                        var id = $(this).data('reportId');
                        var report = getReport(id);
                        setArchiveReport(report, $(this).is(':checked'), true);
                    }
                )
            ),
            $('<td>',{class:'clickable'}).append($img)).append(
            $('<td>',{class:'centered'}).text(report.priority)).append(
            $('<td>',{class:(report.wasRemoved?'removed-report':'')}).text(report.eventDescription.descriptionHeader)).append(
            $('<td>',{class:'centered'}).text(new Date(report.beginTime.time).toString('M/d/y h:mm tt'))
        )
        .click(function () {
            var $row = $(this);
            var id = $row.data('reportId');
            var marker = getReport(id).marker;
            var $imageDiv = report.imageDiv;
            //if (!marker.onScreen()) {
            W.map.moveTo(marker.lonlat);
            //}
            toggleReportPopover($imageDiv);

        }).data('reportId', report.id);
        report.dataRow = $row;
        $table.append($row);
        $row.report = report;
    }


    function onClickColumnHeader(obj) {
        var prop;
        switch (/dot-table-(.*)-header/.exec(obj.id)[1]) {
            case 'category':
                prop = 'icon.image';
                break;
            case 'begins':
                prop = 'beginTime.time';
                break;
            case 'desc':
                prop = 'eventDescription.descriptionHeader';
                break;
            case 'priority':
                prop = 'priority';
                break;
            case 'archive':
                prop = 'archived';
                break;
            default:
                return;
        }
        var idx = _columnSortOrder.indexOf(prop);
        if (idx > -1) {
            _columnSortOrder.splice(idx, 1);
            _columnSortOrder.reverse();
            _columnSortOrder.push(prop);
            _columnSortOrder.reverse();
            buildTable();
        }
    }

    function buildTable() {
        log('Building table', 1);
        var $table = $('<table>',{class:'dot-table'});
        var $th = $('<thead>').appendTo($table);
        $th.append(
            $('<tr>').append(
                $('<th>',{id:'dot-table-star-header',title:'Favorites'}),
                $('<th>', {id:'dot-table-archive-header',class:'centered'}).append(
                    $('<span>', {class:'fa fa-archive',style:'font-size:120%',title:'Sort by archived'})
                ),
                $('<th>', {id:'dot-table-category-header',title:'Sort by report type'}),
                $('<th>', {id:'dot-table-priority-header',title:'Sort by priority'}).append(
                    $('<span>', {class:'fa fa-exclamation-circle',style:'font-size:120%'})
                ),
                $('<th>',{id:'dot-table-desc-header',title:'Sort by description'}).text('Description'),
                $('<th>',{id:'dot-table-begins-header',title:'Sort by starting date'}).text('Starts')
            )
        );
        _reports.sort(dynamicSortMultiple(_columnSortOrder));
        _reports.forEach(function(report) {
            addRow($table, report);
        });
        $('.dot-table').remove();
        $('#dot-report-table').append($table);
        $('.dot-table th').click(function() {onClickColumnHeader(this);});

        updateReportsVisibility();
    }

    function getUrgencyString(imagePath) {
        var i1 = imagePath.lastIndexOf('_');
        var i2 = imagePath.lastIndexOf('.');
        return imagePath.substring(i1+1,i2);
    }

    function addReportToMap(report){
        if(report.location && report.location.primaryPoint && report.icon) {
            var coord = report.location.primaryPoint;
            var size = new OL.Size(report.icon.width,report.icon.height);
            var offset = new OL.Pixel(-(size.w/2), -size.h);
            var startTime = new Date(report.beginTime.time);
            var lastUpdateTime = new Date(report.updateTime.time);
            var now = new Date(Date.now());
            var imgName = report.icon.image;
            if (imgName.indexOf('flooding') != -1) {
                imgName = imgName.replace('flooding','weather').replace('.png','.gif');
            } else if (report.headlinePhrase.category === 5 && report.headlinePhrase.code === 21) {
                imgName = '/tg_flooding_urgent.png';
            }
            if (startTime > now) {
                var futureValue;
                if (startTime > now.clone().addMonths(2)) {
                    futureValue = 'pp';
                } else if (startTime > now.clone().addMonths(1)) {
                    futureValue = 'p';
                } else {
                    futureValue = startTime.getDate();
                }
                imgName = '/tg_future_' + futureValue + '_' + getUrgencyString(imgName) + '.gif';
            }
            report.imgUrl = _imagesPath + imgName;
            var icon = new OL.Icon(report.imgUrl,size,null);
            var marker = new OL.Marker(new OL.LonLat(coord.lon,coord.lat).transform("EPSG:4326", "EPSG:900913"),icon);

            var popoverTemplate = ['<div class="reportPopover popover" style="max-width:500px;width:500px;">',
                                   '<div class="arrow"></div>',
                                   '<div class="popover-title"></div>',
                                   '<div class="popover-content">',
                                   '</div>',
                                   '</div>'].join('');
            marker.report = report;
            //marker.events.register('click', marker, onMarkerClick);
            _mapLayer.addMarker(marker);

            var dot = _dotInfo[_settings.state];
            var content = [
                report.eventDescription.descriptionFull,
                '<div style="margin-top:10px;"><b>Start Time:</b>&nbsp;&nbsp;' + startTime.toString('MMM d, y @ h:mm tt') + '</div>',
                '<div><b>Updated:</b>&nbsp;&nbsp;' + lastUpdateTime.toString('MMM d, y @ h:mm tt') + '&nbsp;&nbsp;(update #' + report.situationUpdateKey.updateNumber + ')</div>',
                '<div"><hr style="margin-bottom:5px;margin-top:5px;border-color:gainsboro"><div style="display:table;width:100%"><button type="button" class="btn btn-primary btn-open-dot-report" data-dot-report-url="' + dot.baseUrl + dot.reportUrl + report.id + '" style="float:left;">Open in DOT website</button><button type="button" class="btn btn-primary btn-zoom-dot-report" data-dot-reportid="' + report.id + '" style="float:left;margin-left:6px;">Zoom</button><button type="button" class="btn btn-primary btn-copy-dot-report" data-dot-reportid="' + report.id + '" style="float:left;margin-left:6px;"><span class="fa fa-copy"></button><button type="button" style="float:right;" class="btn btn-primary btn-archive-dot-report" data-dot-report-id="' + report.id + '">Archive</button></div></div></div>'
            ].join('');
            var $imageDiv = $(marker.icon.imageDiv)
            .css('cursor', 'pointer')
            .addClass('dotReport')
            .attr({
                'data-toggle':'popover',
                title:'',
                'data-content':content,
                'data-original-title':'<div style"width:100%;"><div style="float:left;max-width:330px;color:#5989af;font-size:120%;">' + report.eventDescription.descriptionHeader + '</div><div style="float:right;"><a class="close-popover" href="javascript:void(0);">X</a></div><div style="clear:both;"</div></div>'
            })

            .popover({trigger: 'manual', html:true,placement: 'auto top', template:popoverTemplate})
            .on('click', function() {toggleReportPopover($(this));})
            .data('reportId', report.id)
            .data('state', '');

            $imageDiv.data('report', report);
            if (report.agencyAttribution && report.agencyAttribution.agencyName.toLowerCase().indexOf('waze') != -1) {
                $imageDiv.addClass('wazeReport');
            }
            if (report.archived) { $imageDiv.addClass('dot-archived-marker'); }
            report.imageDiv = $imageDiv;
            report.marker = marker;
        }
    }

    function processReports(reports) {
        var settingsUpdated = false;
        _reports = [];
        _mapLayer.clearMarkers();
        log('Adding reports to map...', 1);
        reports.forEach(function(report, index) {
            if (report.location && report.location.primaryPoint) {
                report.archived = false;
                if (_settings.archivedReports.hasOwnProperty(report.id)) {
                    if ( _settings.archivedReports[report.id].updateNumber < report.situationUpdateKey.updateNumber) {
                        delete _settings.archivedReports[report.id];
                    } else {
                        report.archived = true;
                    }
                }
                _reports.push(report);
            }
        });

        // Check saved starred reports.
        for(var reportId in _settings.starredReports) {
            var starredReport = _settings.starredReports[reportId];
            var report = getReport(reportId);
            if (report) {
                report.starred = true;
                if (report.situationUpdateKey.updateNumber !== starredReport.situationUpdateKey.updateNumber) {
                    _settings.starredReports[report.id] = report;
                    settingsUpdated = true;
                }
            } else {
                // Report has been removed by DOT.
                if (!starredReport.wasRemoved) {
                    starredReport.archived = false;
                    starredReport.wasRemoved = true;
                    settingsUpdated = true;
                }
                _reports.push(starredReport);
            }
        }
        _reports.forEach(function(report) { addReportToMap(report); });
        if (settingsUpdated) { saveSettingsToStorage(); }
        buildTable();
    }

    function fetchReports(callback) {
        var dot = _dotInfo[_settings.state];
        GM_xmlhttpRequest({
            method: "GET",
            url: dot.baseUrl + dot.reportsFeedUrl,
            onload: function(res) { callback($.parseJSON(res.responseText)); }
        });
    }

    function onLayerVisibilityChanged(evt) {
        saveSettingsToStorage();
    }

    function installIcon() {
        OL.Icon = OL.Class({
            url: null,
            size: null,
            offset: null,
            calculateOffset: null,
            imageDiv: null,
            px: null,
            initialize: function(a,b,c,d){
                this.url=a;
                this.size=b||{w: 20,h: 20};
                this.offset=c||{x: -(this.size.w/2),y: -(this.size.h/2)};
                this.calculateOffset=d;
                a=OL.Util.createUniqueID("OL_Icon_");
                var div = this.imageDiv=OL.Util.createAlphaImageDiv(a);
                $(div.firstChild).removeClass('olAlphaImg');   // LEAVE THIS LINE TO PREVENT WME-HARDHATS SCRIPT FROM TURNING ALL ICONS INTO HARDHAT WAZERS --MAPOMATIC
            },
            destroy: function(){ this.erase();OL.Event.stopObservingElement(this.imageDiv.firstChild);this.imageDiv.innerHTML="";this.imageDiv=null; },
            clone: function(){ return new OL.Icon(this.url,this.size,this.offset,this.calculateOffset); },
            setSize: function(a){ null!==a&&(this.size=a); this.draw(); },
            setUrl: function(a){ null!==a&&(this.url=a); this.draw(); },
            draw: function(a){
                OL.Util.modifyAlphaImageDiv(this.imageDiv,null,null,this.size,this.url,"absolute");
                this.moveTo(a);
                return this.imageDiv;
            },
            erase: function(){ null!==this.imageDiv&&null!==this.imageDiv.parentNode&&OL.Element.remove(this.imageDiv); },
            setOpacity: function(a){ OL.Util.modifyAlphaImageDiv(this.imageDiv,null,null,null,null,null,null,null,a); },
            moveTo: function(a){
                null!==a&&(this.px=a);
                null!==this.imageDiv&&(null===this.px?this.display(!1): (
                    this.calculateOffset&&(this.offset=this.calculateOffset(this.size)),
                    OL.Util.modifyAlphaImageDiv(this.imageDiv,null,{x: this.px.x+this.offset.x,y: this.px.y+this.offset.y})
                ));
            },
            display: function(a){ this.imageDiv.style.display=a?"": "none"; },
            isDrawn: function(){ return this.imageDiv&&this.imageDiv.parentNode&&11!=this.imageDiv.parentNode.nodeType; },
            CLASS_NAME: "OpenLayers.Icon"
        });
    }

    function init511ReportsOverlay(){
        installIcon();
        _mapLayer = new OL.Layer.Markers("State DOT Reports", {
            displayInLayerSwitcher: true,
            uniqueName: "__stateDotReports",
        });

        I18n.translations[I18n.locale].layers.name.__stateDotReports = "State DOT Reports";
        W.map.addLayer(_mapLayer);
        _mapLayer.setVisibility(_settings.layerVisible);
        _mapLayer.events.register('visibilitychanged',null,onLayerVisibilityChanged);
    }

    function restoreUserTab() {
        $('#user-tabs > .nav-tabs').append(_tabDiv.tab);
        $('#user-info > .flex-parent > .tab-content').append(_tabDiv.panel);
        $('#stateDotStateSelect').change(function () {
            hideAllReportPopovers();
            _settings.state = this.value;
            saveSettingsToStorage();
            fetchReports(processReports);
        });
        $('[id^=hideDot]').change(function(){
            saveSettingsToStorage();
            updateReportsVisibility();
        });
        $('.dot-refresh-reports').click(function(e) {
            hideAllReportPopovers();
            fetchReports(processReports);
            var refreshPopup = $('#dot-refresh-popup');
            refreshPopup.show();
            setTimeout(function() { refreshPopup.hide(); }, 1500);
            e.stopPropagation();
        });
    }

    function onModeChanged(model, modeId, context) {
        hideAllReportPopovers();
        if(!modeId || modeId === 1) {
            restoreUserTab();
        }
    }

    function initUserPanel() {
        _tabDiv.tab = $('<li>').append(
            $('<a>', {'data-toggle':'tab', href:'#sidepanel-statedot'}).text('DOT').append(
                $('<span>', {title:'Click to refresh DOT reports', class:'fa fa-refresh refreshIcon nav-tab-icon dot-refresh-reports', style:'cursor:pointer;'})
            )
        );

        _tabDiv.panel = $('<div>', {class:'tab-pane', id:'sidepanel-statedot'}).append(
            $('<div>',  {class:'side-panel-section>'}).append(
                $('<div>', {class:'form-group'}).append(
                    $('<label>', {class:'control-label'}).text('Select your state')
                ).append(
                    $('<div>', {class:'controls', id:'state-select'}).append(
                        $('<div>').append(
                            $('<select>', {id:'stateDotStateSelect',class:'form-control'})
                            .append($('<option>', {value:'ID'}).text('Idaho'))
                            .append($('<option>', {value:'IN'}).text('Indiana'))
                            .append($('<option>', {value:'IA'}).text('Iowa'))
                            .append($('<option>', {value:'LA'}).text('Louisiana'))
                            .append($('<option>', {value:'MN'}).text('Minnesota'))
                            .append($('<option>', {value:'NE'}).text('Nebraska'))
                            .val(_settings.state)
                        )
                    )
                ).append(
                    $('<label style="width:100%; cursor:pointer; border-bottom: 1px solid #e0e0e0; margin-top:9px;" data-toggle="collapse" data-target="#dotSettingsCollapse"><span class="fa fa-caret-down" style="margin-right:5px;font-size:120%;"></span>Hide reports...</label>')).append(
                    $('<div>',{id:'dotSettingsCollapse',class:'collapse'}).append(
                        $('<div>',{class:'controls-container'})
                        .append($('<input>', {type:'checkbox',name:'hideDotArchivedReports',id:'hideDotArchivedReports'}))
                        .append($('<label>', {for:'hideDotArchivedReports'}).text('Archived'))
                    ).append(
                        $('<div>',{class:'controls-container'})
                        .append($('<input>', {type:'checkbox',name:'hideDotWazeReports',id:'hideDotWazeReports'}))
                        .append($('<label>', {for:'hideDotWazeReports'}).text('Waze (if supported by DOT)'))
                    ).append(
                        $('<div>',{class:'controls-container'})
                        .append($('<input>', {type:'checkbox',name:'hideDotNormalReports',id:'hideDotNormalReports'}))
                        .append($('<label>', {for:'hideDotNormalReports'}).text('Normal conditions'))
                    ).append(
                        $('<div>',{class:'controls-container'})
                        .append($('<input>', {type:'checkbox',name:'hideDotWeatherReports',id:'hideDotWeatherReports'}))
                        .append($('<label>', {for:'hideDotWeatherReports'}).text('Weather'))
                    ).append(
                        $('<div>',{class:'controls-container'})
                        .append($('<input>', {type:'checkbox',name:'hideDotCrashReports',id:'hideDotCrashReports'}))
                        .append($('<label>', {for:'hideDotCrashReports'}).text('Crash'))
                    ).append(
                        $('<div>',{class:'controls-container'})
                        .append($('<input>', {type:'checkbox',name:'hideDotWarningReports',id:'hideDotWarningReports'}))
                        .append($('<label>', {for:'hideDotWarningReports'}).text('Warning'))
                    ).append(
                        $('<div>',{class:'controls-container'})
                        .append($('<input>', {type:'checkbox',name:'hideDotRestrictionReports',id:'hideDotRestrictionReports'}))
                        .append($('<label>', {for:'hideDotRestrictionReports'}).text('Restriction'))
                    ).append(
                        $('<div>',{class:'controls-container'})
                        .append($('<input>', {type:'checkbox',name:'hideDotClosureReports',id:'hideDotClosureReports'}))
                        .append($('<label>', {for:'hideDotClosureReports'}).text('Closure'))
                    ).append(
                        $('<div>',{class:'controls-container'})
                        .append($('<input>', {type:'checkbox',name:'hideDotFutureReports',id:'hideDotFutureReports'}))
                        .append($('<label>', {for:'hideDotFutureReports'}).text('Future'))
                    ).append(
                        $('<div>',{class:'controls-container'})
                        .append($('<input>', {type:'checkbox',name:'hideDotCurrentReports',id:'hideDotCurrentReports'}))
                        .append($('<label>', {for:'hideDotCurrentReports'}).text('Current/Past'))
                    )
                )
            )
        ).append(
            $('<div>', {class:'side-panel-section>', id:'dot-report-table'}).append(
                $('<div>').append(
                    $('<span>', {title:'Click to refresh DOT reports', class:'fa fa-refresh refreshIcon dot-refresh-reports dot-table-label', style:'cursor:pointer;'})
                ).append(
                    $('<span>',{class:'dot-table-label dot-report-count count'})
                ).append(
                    $('<span>',{class:'dot-table-label dot-table-action right'}).text('Archive all').click(function() {
                        var r = confirm('Are you sure you want to archive all reports for ' + _settings.state + '?');
                        if (r===true) {
                            archiveAllReports(false);
                        }
                    })
                ).append(
                    $('<span>', {class:'dot-table-label right'}).text('|')
                ).append(
                    $('<span>',{class:'dot-table-label dot-table-action right'}).text('Un-Archive all').click(function() {
                        var r = confirm('Are you sure you want to un-archive all reports for ' + _settings.state + '?');
                        if (r===true) {
                            archiveAllReports(true);
                        }
                    })
                )
            )
        );

        restoreUserTab();
        $('<div>', {id: 'dot-refresh-popup',}).text('DOT Reports Refreshed').hide().appendTo($('div#editor-container'));

        (function setChecks(settingProps, checkboxIds) {
            for (var i=0; i<settingProps.length; i++) {
                if (_settings[settingProps[i]]) { $('#' + checkboxIds[i]).attr('checked', 'checked'); }
            }
        })(['hideArchivedReports','hideWazeReports','hideNormalReports','hideWeatherReports','hideTrafficReports','hideCrashReports','hideWarningReports','hideRestrictionReports','hideClosureReports','hideFutureReports','hideCurrentReports'],
           ['hideDotArchivedReports','hideDotWazeReports','hideDotNormalReports','hideDotWeatherReports','hideDotTrafficReports','hideDotCrashReports','hideDotWarningReports','hideDotRestrictionReports','hideDotClosureReports','hideDotFutureReports','hideDotCurrentReports']);
    }

    function showScriptInfoAlert() {
        /* Check version and alert on update */
        console.log(_scriptVersion);
        if (_alertUpdate && _scriptVersion !== _settings.lastVersion) {
            alert(_scriptVersionChanges);
        }
    }

    function initGui() {
        init511ReportsOverlay();
        initUserPanel();
        showScriptInfoAlert();
        fetchReports(processReports);

        var classHtml =  [
            '.dot-table th,td,tr {cursor:default;} ',
            '.dot-table .centered {text-align:center;} ',
            '.dot-table th:hover,tr:hover {background-color:aliceblue; outline: -webkit-focus-ring-color auto 5px;} ',
            '.dot-table th:hover {color:blue; border-color:whitesmoke; } ',
            '.dot-table {border:1px solid gray; border-collapse:collapse; width:100%; font-size:83%;margin:0px 0px 0px 0px} ',
            '.dot-table th,td {border:1px solid gainsboro;} ',
            '.dot-table td,th {color:black; padding:1px 4px;} ',
            '.dot-table th {background-color:gainsboro;} ',
            '.dot-table .table-img {max-width:24px; max-height:24px;} ',
            '.tooltip.top > .tooltip-arrow {border-top-color:white;} ',
            '.tooltip.bottom > .tooltip-arrow {border-bottom-color:white;} ',
            'a.close-popover {text-decoration:none;padding:0px 3px;border-width:1px;background-color:white;border-color:ghostwhite} a.close-popover:hover {padding:0px 4px;border-style:outset;border-width:1px;background-color:white;border-color:ghostwhite;} ',
            '#dot-refresh-popup {position:absolute;z-index:9999;top:80px;left:650px;background-color:rgb(120,176,191);e;font-size:120%;padding:3px 11px;box-shadow:6px 8px rgba(20,20,20,0.6);border-radius:5px;color:white;} ',
            '.refreshIcon:hover {color:blue; text-shadow: 2px 2px #aaa;} .refreshIcon:active{ text-shadow: 0px 0px; } ',
            '.dot-archived-marker {opacity:0.5;} ',
            '.dot-table-label {font-size:85%;} .dot-table-action:hover {color:blue;cursor:pointer} .dot-table-label.right {float:right} .dot-table-label.count {margin-left:4px;} ',
            '.dot-table .star {cursor:pointer;width:18px;height:18px;margin-top:3px;} ',
            '.dot-table .star-empty {content:url(' + _imagesPath + '/star-empty.png);} ',
            '.dot-table .star-filled {content:url('+ _imagesPath + '/star-filled.png);} ',
            '.dot-table .removed-report {text-decoration:line-through;color:#bbb} '
        ].join('');
        $('<style type="text/css">' + classHtml + '</style>').appendTo('head');

        _previousZoom = W.map.zoom;
        W.map.events.register('moveend',null,function() {if (_previousZoom !== W.map.zoom) {hideAllReportPopovers();} _previousZoom=W.map.zoom;});
    }

    function loadSettingsFromStorage() {
        var settings = $.parseJSON(localStorage.getItem(_settingsStoreName));
        if(!settings) {
            settings = {
                lastVersion:null,
                layerVisible:true,
                state:'ID',
                hideArchivedReports:true,
                archivedReports:{}
            };
        } else {
            settings.layerVisible = (settings.layerVisible === true);
            settings.state = settings.state ? settings.state : 'KY';
            if(typeof settings.hideArchivedReports === 'undefined') { settings.hideArchivedReports = true; }
            settings.archivedReports = settings.archivedReports ? settings.archivedReports : {};
            settings.starredReports = settings.starredReports ? settings.starredReports : {};
        }
        _settings = settings;
    }

    function init() {
        loadSettingsFromStorage();
        initGui();
        unsafeWindow.addEventListener('beforeunload', function saveOnClose() { saveSettingsToStorage(); }, false);
        W.app.modeController.model.bind('change:mode', onModeChanged);
        log('Initialized.', 0);
    }

    function bootstrap() {
        if (W && W.loginManager &&
            W.loginManager.events.register &&
            W.map && W.loginManager.isLoggedIn()) {
            log('Initializing...', 1);
            init();
        } else {
            log('Bootstrap failed. Trying again...', 1);
            setTimeout(function () {
                bootstrap();
            }, 1000);
        }
    }

    log('Bootstrap...', 1);
    bootstrap();
})();
