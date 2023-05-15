LIBDIR := lib
GHPAGES_EXTRA := demo-patch-byterange-server/client.xhtml
include $(LIBDIR)/main.mk

$(GHPAGES_TARGET)/demo-patch-byterange-server/client.xhtml: demo-patch-byterange-server/client.xhtml $(GHPAGES_TARGET)/demo-patch-byterange-server
	cp -f $(@:$(GHPAGES_TARGET)/%=%) $@

$(GHPAGES_TARGET)/demo-patch-byterange-server: $(GHPAGES_TARGET)
	mkdir -p $@

$(LIBDIR)/main.mk:
ifneq (,$(shell grep "path *= *$(LIBDIR)" .gitmodules 2>/dev/null))
	git submodule sync
	git submodule update $(CLONE_ARGS) --init
else
	git clone -q --depth 10 $(CLONE_ARGS) \
	    -b main https://github.com/martinthomson/i-d-template $(LIBDIR)
endif
