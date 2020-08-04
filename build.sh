#!/bin/bash

set -ex

mkdir -p build
for os in {alpine,linux,mac,windows}; do
	npx nexe -o scat -i index.js -t "$os-x64-12.9.1"
	if [[ "$os" == "windows" ]]; then
		zip -r "build/scat-$os-x64.zip" scat.exe
		rm -f scat.exe
	else
		zip -r "build/scat-$os-x64.zip" scat
		rm -f scat
	fi

	if [[ "$os" != "mac" ]]; then
		npx nexe -o scat -i index.js -t "$os-x86-12.9.1"
		if [[ "$os" == "windows" ]]; then
			zip -r "build/scat-$os-x86.zip" scat.exe
			rm -f scat.exe
		else
			zip -r "build/scat-$os-x86.zip" scat
			rm -f scat
		fi
	fi
done


